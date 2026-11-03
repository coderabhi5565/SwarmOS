"""Per-run runtime: provider, model selection, ledger, trace, and workspace."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from app.config import ModelProfile, Settings
from app.models import Limits, ModelTier, Plan, TraceEvent, TraceKind
from app.providers.base import ModelUnavailableError, Provider
from app.runtime.limits import BudgetLedger
from app.runtime.trace import TraceRecorder
from app.runtime.workspace import Workspace
from app.timings import DISABLED, SpanRecorder

# Policies only change model selection, not the orchestration graph.
#   config      -> honour SWARMOS_ROLE_MODELS
#   fast_only   -> every role uses the fast profile and escalation is disabled
#   adaptive    -> every role starts fast; escalation to strong is allowed
#   role_routed -> honour SWARMOS_ROLE_MODELS, escalation allowed
VALID_POLICIES = {"config", "fast_only", "adaptive", "role_routed"}


def model_profiles(provider_name: str, settings: Settings) -> dict[str, ModelProfile]:
    """The model profiles a run on ``provider_name`` can use."""
    # The demo fixture never calls the configured endpoint, so it must not
    # inherit that endpoint's model ids into the run record.
    if provider_name == "demo":
        return {"fast": ModelProfile("fast", "demo-fast")}
    profiles = settings.configured_profiles()
    if not profiles:
        # Unconfigured runs still carry a coherent label.
        profiles = {"fast": ModelProfile("fast", settings.model_for("fast"))}
    return profiles


def escalation_possible(profiles: dict[str, ModelProfile]) -> bool:
    """Whether a run can escalate: its provider offers a distinct strong model.

    Judged from the run's own profiles, never from the configured endpoint
    alone: a demo-fixture run has a single scripted model even when the
    endpoint has a strong one.
    """
    return "strong" in profiles


def select_role_profile(
    role: str, policy: str, profiles: dict[str, ModelProfile], settings: Settings
) -> ModelProfile:
    """The profile ``role`` uses under ``policy``, from the available profiles."""
    fast = profiles.get("fast") or next(iter(profiles.values()))
    if policy in {"fast_only", "adaptive"}:
        return fast
    # config / role_routed
    if escalation_possible(profiles):
        name = settings.role_routing().get(role, "fast")
        if name in profiles:
            return profiles[name]
    return fast


class RunRuntime:
    def __init__(
        self,
        *,
        run_id: str,
        settings: Settings,
        limits: Limits,
        provider: Provider,
        provider_name: str,
        provider_warning: str | None,
        store: object | None = None,
        model_policy: str | None = None,
        demo_task: str | None = None,
        seeded_plan: Plan | None = None,
        allowed_files: frozenset[str] | None = None,
        read_only_files: frozenset[str] = frozenset(),
        timings: SpanRecorder | None = None,
    ) -> None:
        self.run_id = run_id
        # The run's span recorder (a disabled one when not measured), and the
        # lifecycle spans the orchestrator closes or nests under.
        self.timings = timings if timings is not None else DISABLED
        self.setup_span: int | None = None
        self.execution_span: int | None = None
        self.settings = settings
        self.limits = limits
        self.provider = provider
        self.provider_name = provider_name
        self.provider_warning = provider_warning
        self.demo_task = demo_task
        self.seeded_plan = seeded_plan
        self.allowed_files = allowed_files
        self.read_only_files = read_only_files
        policy = (model_policy or settings.model_policy or "config").strip().lower()
        self.model_policy = policy if policy in VALID_POLICIES else "config"
        self.ledger = BudgetLedger(
            max_usd=limits.max_budget_usd,
            max_calls=limits.max_agent_calls,
            max_wall_seconds=limits.max_wall_seconds,
            reservation_usd=settings.reservation_usd,
            monetary_enforced=settings.monetary_enforced,
        )
        self.trace = TraceRecorder(run_id, store)
        self._temp_root = Path(tempfile.mkdtemp(prefix=f"swarmos-{run_id}-"))
        self.workspace = self._new_workspace(self._temp_root / "workspace")
        self.step_root = self._temp_root / "steps"
        self.step_root.mkdir(parents=True, exist_ok=True)

    def _new_workspace(self, root: Path) -> Workspace:
        return Workspace(
            root,
            char_limit=self.settings.snapshot_char_limit,
            execution_enabled=self.settings.execution_enabled,
            allowed_commands=self.settings.allowed_command_set,
            sandbox=self.settings.execution_sandbox,
        )

    # ------------------------------------------------------------------
    # workspace
    # ------------------------------------------------------------------
    def seed_workspace(self, files: dict[str, str], fallback: Path) -> None:
        if files:
            self.workspace.seed(files)
        elif fallback and fallback.is_dir():
            self.workspace = Workspace.from_directory(
                fallback, self._temp_root / "workspace"
            )
            self.workspace.char_limit = self.settings.snapshot_char_limit
            self.workspace.execution_enabled = self.settings.execution_enabled
            self.workspace.allowed_commands = self.settings.allowed_command_set
            self.workspace.sandbox = self.settings.execution_sandbox
        else:
            self.workspace.write(
                "README.md",
                "# SwarmOS workspace\n\nThis run started from an empty workspace.\n",
            )

    def snapshot(self) -> dict[str, str]:
        return self.workspace.snapshot()

    # ------------------------------------------------------------------
    # model selection
    # ------------------------------------------------------------------
    @property
    def profiles(self) -> dict[str, ModelProfile]:
        return model_profiles(self.provider_name, self.settings)

    def selection_for_role(self, role: str) -> ModelProfile:
        """Return the profile a role should use under the active policy."""
        return select_role_profile(role, self.model_policy, self.profiles, self.settings)

    def selection_for_tier(self, tier: ModelTier) -> ModelProfile:
        """Resolve an explicit tier. A missing strong profile is an error, not a
        silent downgrade to the fast model."""
        profiles = self.profiles
        if tier == "strong":
            strong = profiles.get("strong")
            if strong is None:
                raise ModelUnavailableError(
                    "no distinct strong model is configured; escalation is "
                    "impossible. Set OPENAI_COMPAT_MODEL_STRONG to a different "
                    "model id to enable escalation."
                )
            return strong
        return profiles.get("fast") or next(iter(profiles.values()))

    def model_for(self, tier: ModelTier) -> str:
        return self.selection_for_tier(tier).model

    def rates_for(self, model: str) -> tuple[float, float]:
        return self.settings.rates_for(model)

    @property
    def escalation_available(self) -> bool:
        """Whether this run can escalate, from its provider's profiles."""
        return escalation_possible(self.profiles)

    # ------------------------------------------------------------------
    # cost
    # ------------------------------------------------------------------
    def cost_for(self, profile: ModelProfile, input_tokens: int, output_tokens: int) -> float:
        if not profile.priced or not self.settings.monetary_enforced:
            return 0.0
        return (
            input_tokens * profile.input_rate + output_tokens * profile.output_rate
        ) / 1_000_000

    def estimate_call_cost(self, profile: ModelProfile) -> float:
        """Reserve only when a real price exists for this exact model.

        With no configured rates the honest estimate is zero; USD enforcement
        is then explicitly reported as inactive and call/time limits govern.
        """
        if not profile.priced or not self.settings.monetary_enforced:
            return 0.0
        return max(0.0, self.settings.reservation_usd)

    # ------------------------------------------------------------------
    def emit(self, kind: TraceKind, message: str = "", **payload: object) -> TraceEvent:
        return self.trace.emit(kind, message, **payload)

    def cleanup(self) -> None:
        shutil.rmtree(self._temp_root, ignore_errors=True)