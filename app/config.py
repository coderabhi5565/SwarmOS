"""Process configuration.

Every tunable that affects money, time, or autonomy is read here once so that
limits cannot be silently widened deep inside the orchestrator.

Provider assumptions, stated plainly:

* a "provider" is any OpenAI-compatible chat-completions endpoint, including a
  local runtime such as Ollama;
* an API key is optional because local inference usually has none;
* monetary enforcement is only claimed when per-token rates are configured for
  every profile that can be used.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parent.parent

ROLES = ("planner", "coder", "reviewer", "verifier")
DEFAULT_ROLE_ROUTING = {"planner": "fast", "coder": "fast", "reviewer": "fast"}
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"}


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    return int(raw) if raw else default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    return float(raw) if raw else default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _public_demo() -> bool:
    """Whether SWARMOS_MODE selects the restricted public demo profile."""
    return os.getenv("SWARMOS_MODE", "local").strip().lower() == "public_demo"


def _env_path(name: str, default: Path) -> Path:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    path = Path(raw).expanduser()
    return path if path.is_absolute() else (PROJECT_ROOT / path)


@dataclass(frozen=True)
class ModelProfile:
    """One selectable model: an id plus optional pricing for that id."""

    name: str
    model: str
    input_rate: float = 0.0
    output_rate: float = 0.0

    @property
    def priced(self) -> bool:
        return self.input_rate > 0 and self.output_rate > 0

    def describe(self) -> dict[str, object]:
        return {
            "name": self.name,
            "model": self.model,
            "priced": self.priced,
            "input_usd_per_million": self.input_rate,
            "output_usd_per_million": self.output_rate,
        }


@dataclass(frozen=True)
class Settings:
    # Provider selection: "auto" | "demo" | "openai". The per-request value wins;
    # this is only a default for clients that do not send one.
    provider: str = os.getenv("SWARMOS_PROVIDER", "auto").strip().lower()

    # OpenAI-compatible endpoint. Works for Ollama, vLLM, llama.cpp server, LM
    # Studio, and hosted compatible APIs. An API key is optional.
    base_url: str = os.getenv("OPENAI_COMPAT_BASE_URL", "").strip().rstrip("/")
    api_key: str = os.getenv("OPENAI_COMPAT_API_KEY", "").strip()
    fast_model: str = os.getenv("OPENAI_COMPAT_MODEL_FAST", "").strip()
    strong_model: str = os.getenv("OPENAI_COMPAT_MODEL_STRONG", "").strip()

    fast_input_rate: float = _env_float("FAST_INPUT_USD_PER_MILLION", 0.0)
    fast_output_rate: float = _env_float("FAST_OUTPUT_USD_PER_MILLION", 0.0)
    strong_input_rate: float = _env_float("STRONG_INPUT_USD_PER_MILLION", 0.0)
    strong_output_rate: float = _env_float("STRONG_OUTPUT_USD_PER_MILLION", 0.0)

    # Role -> profile map, e.g. "planner=strong,coder=fast,reviewer=strong".
    role_models: str = os.getenv("SWARMOS_ROLE_MODELS", "").strip()
    model_policy: str = os.getenv("SWARMOS_MODEL_POLICY", "config").strip().lower()

    request_timeout_seconds: int = _env_int("SWARMOS_PROVIDER_TIMEOUT_SECONDS", 90)
    retry_backoff_seconds: float = _env_float("SWARMOS_RETRY_BACKOFF_SECONDS", 0.5)
    json_mode: bool = _env_bool("SWARMOS_JSON_MODE", True)
    snapshot_char_limit: int = _env_int("SWARMOS_SNAPSHOT_CHAR_LIMIT", 400_000)

    # Hard defaults. A request may lower these but never raise the process cap.
    max_agent_calls: int = _env_int("SWARMOS_MAX_AGENT_CALLS", 24)
    max_budget_usd: float = _env_float("SWARMOS_MAX_BUDGET_USD", 0.50)
    max_wall_seconds: int = _env_int("SWARMOS_MAX_WALL_SECONDS", 300)
    max_retries: int = _env_int("SWARMOS_MAX_RETRIES", 2)
    max_revisions: int = _env_int("SWARMOS_MAX_REVISIONS", 1)
    max_escalations: int = _env_int("SWARMOS_MAX_ESCALATIONS", 1)

    # Conservative per-call reservation used when pricing is known.
    reservation_usd: float = _env_float("SWARMOS_RESERVATION_USD", 0.02)

    # Verification and execution safety.
    verification_command: str = os.getenv("SWARMOS_VERIFY_COMMAND", "python -m pytest -q")
    verification_timeout_seconds: int = _env_int("SWARMOS_VERIFY_TIMEOUT_SECONDS", 120)
    execution_enabled: bool = _env_bool("SWARMOS_EXECUTION_ENABLED", True)
    allowed_commands: str = os.getenv(
        "SWARMOS_ALLOWED_COMMANDS", "python,python3,py,pytest"
    ).strip()
    allow_repo_checkout: bool = _env_bool("SWARMOS_ALLOW_REPO_CHECKOUT", False)

    # Deployment profile. "local" is the full developer tool. "public_demo" is
    # the internet-facing portfolio demo: curated tasks only, generated code
    # checked by a static policy, tests run under the restricted launcher, and
    # per-client rate limits. The other defaults below follow this value.
    mode: str = os.getenv("SWARMOS_MODE", "local").strip().lower()
    execution_sandbox: str = field(
        default_factory=lambda: os.getenv(
            "SWARMOS_EXECUTION_SANDBOX", "restricted" if _public_demo() else "none"
        ).strip().lower()
    )
    code_policy_enabled: bool = field(
        default_factory=lambda: _env_bool("SWARMOS_CODE_POLICY", _public_demo())
    )
    # 0 means unlimited.
    max_concurrent_runs: int = field(
        default_factory=lambda: _env_int(
            "SWARMOS_MAX_CONCURRENT_RUNS", 2 if _public_demo() else 0
        )
    )
    runs_per_client_per_hour: int = field(
        default_factory=lambda: _env_int(
            "SWARMOS_RUNS_PER_CLIENT_PER_HOUR", 6 if _public_demo() else 0
        )
    )
    # Live trace streams (GET /api/runs/{id}/stream). Each holds a connection
    # open, so the public demo caps them per client and in total (0 means
    # unlimited). A stream is closed after stream_max_seconds; clients resume
    # from their cursor, so a long run costs reconnects, never events.
    max_streams: int = field(
        default_factory=lambda: _env_int("SWARMOS_MAX_STREAMS", 40 if _public_demo() else 0)
    )
    max_streams_per_client: int = field(
        default_factory=lambda: _env_int(
            "SWARMOS_MAX_STREAMS_PER_CLIENT", 4 if _public_demo() else 0
        )
    )
    stream_heartbeat_seconds: float = _env_float("SWARMOS_STREAM_HEARTBEAT_SECONDS", 15.0)
    stream_max_seconds: float = _env_float("SWARMOS_STREAM_MAX_SECONDS", 600.0)
    # Only behind a proxy you control (e.g. Render) may X-Forwarded-For name
    # the client; otherwise any caller could pick its own rate-limit bucket.
    trust_proxy_headers: bool = _env_bool("SWARMOS_TRUST_PROXY_HEADERS", False)
    # Extra allowed CORS origins, comma-separated (e.g. the deployed frontend).
    cors_origins: str = os.getenv("SWARMOS_CORS_ORIGINS", "").strip()

    # API surface safety.
    api_token: str = os.getenv("SWARMOS_API_TOKEN", "").strip()
    allow_remote_bind: bool = _env_bool("SWARMOS_ALLOW_REMOTE_BIND", False)

    db_path: Path = field(
        default_factory=lambda: _env_path("SWARMOS_DB_PATH", PROJECT_ROOT / "swarmos.db")
    )
    sample_project: Path = field(
        default_factory=lambda: _env_path(
            "SWARMOS_SAMPLE_PROJECT", PROJECT_ROOT / "samples" / "sample_project"
        )
    )
    frontend_dist: Path = field(
        default_factory=lambda: _env_path(
            "SWARMOS_FRONTEND_DIST", PROJECT_ROOT / "frontend" / "dist"
        )
    )

    # ------------------------------------------------------------------
    # provider readiness
    # ------------------------------------------------------------------
    @property
    def openai_configured(self) -> bool:
        """A usable endpoint needs a base URL and a fast model; a key is optional."""
        return bool(self.base_url and self.fast_model)

    @property
    def provider_kind(self) -> str:
        if not self.openai_configured:
            return "demo"
        host = (urlparse(self.base_url).hostname or "").lower()
        return "local" if host in LOCAL_HOSTS else "remote"

    def configured_profiles(self) -> dict[str, ModelProfile]:
        profiles: dict[str, ModelProfile] = {}
        if self.fast_model:
            profiles["fast"] = ModelProfile(
                "fast", self.fast_model, self.fast_input_rate, self.fast_output_rate
            )
        # A "strong" profile only exists when it is genuinely a different model.
        if self.strong_model and self.strong_model != self.fast_model:
            profiles["strong"] = ModelProfile(
                "strong",
                self.strong_model,
                self.strong_input_rate,
                self.strong_output_rate,
            )
        return profiles

    @property
    def escalation_available(self) -> bool:
        return "strong" in self.configured_profiles()

    @property
    def pricing_known(self) -> bool:
        profiles = self.configured_profiles()
        return bool(profiles) and all(profile.priced for profile in profiles.values())

    @property
    def monetary_enforced(self) -> bool:
        """USD is only a real control when the provider is real and priced."""
        return self.openai_configured and self.pricing_known

    def profile_for_tier(self, tier: str | None) -> ModelProfile | None:
        profiles = self.configured_profiles()
        if tier and tier in profiles:
            return profiles[tier]
        return profiles.get("fast")

    def model_for(self, tier: str) -> str:
        profile = self.profile_for_tier(tier)
        if profile is not None:
            return profile.model
        return "demo-fast"

    def rates_for(self, model: str) -> tuple[float, float]:
        for profile in self.configured_profiles().values():
            if profile.model == model:
                return profile.input_rate, profile.output_rate
        return 0.0, 0.0

    def role_routing(self) -> dict[str, str]:
        """Resolve role -> profile name, ignoring unknown or unavailable profiles."""
        profiles = self.configured_profiles()
        routing = dict(DEFAULT_ROLE_ROUTING)
        for item in self.role_models.split(","):
            name, _, value = item.partition("=")
            name, value = name.strip().lower(), value.strip().lower()
            if name in ROLES and value in profiles:
                routing[name] = value
        if not self.escalation_available:
            routing = {role: "fast" for role in routing}
        return routing

    @property
    def is_public_demo(self) -> bool:
        return self.mode == "public_demo"

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]

    def startup_errors(self) -> list[str]:
        """Configuration that must stop the API from starting."""
        errors: list[str] = []
        if self.mode not in {"local", "public_demo"}:
            errors.append(f"SWARMOS_MODE must be 'local' or 'public_demo', not {self.mode!r}")
        if self.execution_sandbox not in {"none", "restricted"}:
            errors.append(
                "SWARMOS_EXECUTION_SANDBOX must be 'none' or 'restricted', "
                f"not {self.execution_sandbox!r}"
            )
        if self.stream_heartbeat_seconds <= 0 or self.stream_max_seconds <= 0:
            errors.append(
                "SWARMOS_STREAM_HEARTBEAT_SECONDS and SWARMOS_STREAM_MAX_SECONDS must be positive"
            )
        if self.is_public_demo:
            # The public demo never executes model-written code outside the
            # restricted launcher, and never skips the static code policy.
            if self.execution_enabled and self.execution_sandbox != "restricted":
                errors.append(
                    "public_demo requires SWARMOS_EXECUTION_SANDBOX=restricted "
                    "(or SWARMOS_EXECUTION_ENABLED=0)"
                )
            if not self.code_policy_enabled:
                errors.append("public_demo requires SWARMOS_CODE_POLICY=1")
            if self.allow_repo_checkout:
                errors.append("public_demo does not allow SWARMOS_ALLOW_REPO_CHECKOUT")
        return errors

    @property
    def allowed_command_set(self) -> set[str]:
        return {
            item.strip().lower()
            for item in self.allowed_commands.split(",")
            if item.strip()
        }

    def describe(self) -> dict[str, object]:
        profiles = self.configured_profiles()
        return {
            "mode": self.mode,
            "provider_mode": self.provider,
            "provider_kind": self.provider_kind,
            "openai_configured": self.openai_configured,
            "base_url": self.base_url,
            "auth_configured": bool(self.api_key),
            "json_mode": self.json_mode,
            "profiles": {name: p.describe() for name, p in profiles.items()},
            "role_routing": self.role_routing(),
            "model_policy": self.model_policy,
            "escalation_available": self.escalation_available,
            "pricing_known": self.pricing_known,
            "monetary_enforced": self.monetary_enforced,
        }


settings = Settings()