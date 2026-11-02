"""Run lifecycle: resolve a provider, prepare a record, execute, persist."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

from app.config import Settings
from app.demo_tasks import DemoTask, DemoTaskError, resolve_demo_task
from app.models import Limits, RunRecord, RunRequest, utc_now
from app.orchestrator import Orchestrator
from app.providers import provider_kind, resolve_provider
from app.providers.base import Provider
from app.runtime.runtime import VALID_POLICIES, RunRuntime
from app.store import RunStore


def demo_limits(requested: Limits, recipe: Limits) -> Limits:
    """The recipe is a ceiling for its demo: callers may lower it, never raise it."""
    return Limits(
        max_agent_calls=min(requested.max_agent_calls, recipe.max_agent_calls),
        max_budget_usd=min(requested.max_budget_usd, recipe.max_budget_usd),
        max_wall_seconds=min(requested.max_wall_seconds, recipe.max_wall_seconds),
        max_retries=min(requested.max_retries, recipe.max_retries),
        max_revisions=min(requested.max_revisions, recipe.max_revisions),
        max_escalations=min(requested.max_escalations, recipe.max_escalations),
        parallel_coding=requested.parallel_coding,
    )


def effective_provider_choice(requested: str, settings: Settings) -> str:
    """A per-request choice wins; ``auto`` honours the process default.

    Without this, SWARMOS_PROVIDER was displayed but never applied.
    """
    choice = (requested or "auto").strip().lower()
    if choice != "auto":
        return choice
    configured = (settings.provider or "auto").strip().lower()
    return configured if configured in {"demo", "openai"} else "auto"


def clamp_limits(requested: Limits, policy: str, settings: Settings) -> Limits:
    """The limits a run gets: the request, never above the process ceiling."""
    max_escalations = min(requested.max_escalations, settings.max_escalations)
    if policy == "fast_only":
        # A policy that pins every role to the fast profile cannot escalate;
        # silently escalating would contradict the policy.
        max_escalations = 0
    return Limits(
        max_agent_calls=min(requested.max_agent_calls, settings.max_agent_calls),
        max_budget_usd=min(requested.max_budget_usd, settings.max_budget_usd),
        max_wall_seconds=min(requested.max_wall_seconds, settings.max_wall_seconds),
        max_retries=min(requested.max_retries, settings.max_retries),
        max_revisions=min(requested.max_revisions, settings.max_revisions),
        max_escalations=max_escalations,
        parallel_coding=requested.parallel_coding,
    )


class PublicDemoError(ValueError):
    """The request is not allowed in the restricted public demo."""


class CapacityError(RuntimeError):
    """Too many runs are already in flight."""


@dataclass
class _ActiveRun:
    task: asyncio.Task
    # None until ``execute`` has started and built the runtime.
    runtime: RunRuntime | None = None
    reason: str | None = None


class RunService:
    def __init__(self, settings: Settings, store: RunStore) -> None:
        self.settings = settings
        self.store = store
        self._tasks: set[asyncio.Task] = set()
        self._active: dict[str, _ActiveRun] = {}

    def resolve_policy(self, requested: str | None) -> str:
        policy = (requested or self.settings.model_policy or "config").strip().lower()
        return policy if policy in VALID_POLICIES else "config"

    def effective_provider(self, requested: str) -> str:
        return effective_provider_choice(requested, self.settings)

    def clamp_limits(self, requested: Limits, policy: str) -> Limits:
        return clamp_limits(requested, policy, self.settings)

    def check_public_demo(self, request: RunRequest) -> None:
        """In the public demo, visitors choose a catalog task and nothing else.

        No free-form goal, no seed files, and no provider override: the code
        the agents write is driven only by prompts this server controls.
        """
        if not self.settings.is_public_demo:
            return
        if request.demo_task is None:
            raise PublicDemoError(
                "the public demo runs catalog tasks only; choose one from /api/demo-tasks"
            )
        if request.files:
            raise PublicDemoError("the public demo does not accept seed files")
        if request.provider != "auto":
            raise PublicDemoError("the public demo uses the server's provider")

    def check_capacity(self) -> None:
        limit = self.settings.max_concurrent_runs
        if limit > 0 and len(self._active) >= limit:
            raise CapacityError(
                f"{len(self._active)} run(s) already in flight; the limit is {limit}"
            )

    def prepare(self, request: RunRequest) -> tuple[RunRecord, Provider, str, DemoTask | None]:
        self.check_public_demo(request)
        self.check_capacity()
        demo = resolve_demo_task(request.demo_task) if request.demo_task else None
        if demo is not None and request.files:
            raise DemoTaskError(
                "demo_task runs the bundled sample project and does not accept custom files"
            )
        provider, provider_name, warning = resolve_provider(
            self.effective_provider(request.provider), self.settings
        )
        policy = self.resolve_policy(request.model_policy)
        limits = (
            self.clamp_limits(demo_limits(request.limits, demo.limits), policy)
            if demo is not None
            else self.clamp_limits(request.limits, policy)
        )
        record = RunRecord(
            goal=demo.goal if demo is not None else request.goal,
            provider=provider_name,
            provider_kind=provider_kind(provider_name, self.settings),
            provider_warning=warning,
            limits=limits,
            model_policy=policy,
            monetary_enforced=self.settings.monetary_enforced,
            status="queued",
        )
        self.store.save_run(record)
        return record, provider, policy, demo

    async def run_request(self, request: RunRequest) -> RunRecord:
        record, provider, policy, demo = self.prepare(request)
        return await self.execute(record, provider, request.files, policy, demo)

    def submit(self, request: RunRequest) -> RunRecord:
        return self.start(request)[0]

    def start(self, request: RunRequest) -> tuple[RunRecord, asyncio.Task[RunRecord]]:
        """Start a run in the background; returns its record and its task.

        Raises like ``prepare`` (public demo, capacity, provider) before any
        run is created. Cancel the run with ``cancel``, not the task.
        """
        record, provider, policy, demo = self.prepare(request)
        task = asyncio.create_task(
            self.execute(record, provider, request.files, policy, demo)
        )
        self._tasks.add(task)
        self._active[record.run_id] = _ActiveRun(task=task)
        task.add_done_callback(self._tasks.discard)
        return record, task

    async def execute(
        self,
        record: RunRecord,
        provider: Provider,
        files: dict[str, str],
        policy: str | None = None,
        demo: DemoTask | None = None,
    ) -> RunRecord:
        running = record.model_copy(update={"status": "running", "updated_at": utc_now()})
        self.store.save_run(running)

        runtime = RunRuntime(
            run_id=record.run_id,
            settings=self.settings,
            limits=record.limits,
            provider=provider,
            provider_name=record.provider,
            provider_warning=record.provider_warning,
            store=self.store,
            model_policy=policy or record.model_policy,
            demo_task=demo.id if demo is not None else None,
            seeded_plan=demo.plan if demo is not None else None,
            allowed_files=(
                frozenset(demo.allowed_files) if demo is not None else None
            ),
            read_only_files=(
                frozenset(demo.read_only_files)
                if demo is not None
                else frozenset()
            ),
        )
        runtime.seed_workspace(
            {} if demo is not None else files, self.settings.sample_project
        )
        started = time.perf_counter()
        task = asyncio.current_task()
        if task is not None:
            active = self._active.setdefault(record.run_id, _ActiveRun(task=task))
            active.runtime = runtime
        try:
            result = await Orchestrator(runtime).run(running)
            self.store.save_run(result.record)
            return result.record
        except asyncio.CancelledError:
            active = self._active.get(record.run_id)
            reason = (active.reason if active else None) or "run cancelled before completion"
            runtime.emit("run_finished", f"Run finished: cancelled ({reason})",
                         status="cancelled", error=reason)
            # Keep the progress persisted so far (plan, calls, review) and only
            # change what the cancellation changed.
            latest = self.store.get_run(record.run_id) or running
            cancelled = latest.model_copy(
                update={
                    "status": "cancelled",
                    "error": reason,
                    "duration_ms": int((time.perf_counter() - started) * 1000),
                    "updated_at": utc_now(),
                }
            )
            self.store.save_run(cancelled)
            raise
        except Exception as exc:  # noqa: BLE001 - never leave a run stuck in "running"
            runtime.emit(
                "failure",
                "Run crashed",
                error=f"{type(exc).__name__}: {exc}",
                error_class="run_crashed",
            )
            failed = running.model_copy(
                update={
                    "status": "failed",
                    "error": f"{type(exc).__name__}: {exc}",
                    "duration_ms": int((time.perf_counter() - started) * 1000),
                    "updated_at": utc_now(),
                }
            )
            self.store.save_run(failed)
            return failed
        finally:
            self._active.pop(record.run_id, None)
            runtime.cleanup()

    def is_active(self, run_id: str) -> bool:
        return run_id in self._active

    def cancel(self, run_id: str, reason: str = "cancelled on request") -> bool:
        """Cancel an in-flight run in this process. Returns False if not active.

        The orchestration task is cancelled and the verification process tree,
        which runs on a worker thread, is killed so it cannot outlive the run.
        """
        active = self._active.get(run_id)
        if active is None or active.task.done():
            return False
        active.reason = reason
        if active.runtime is not None:
            active.runtime.workspace.kill_active_process()
        else:
            # Not started yet: its body will never run, so record the outcome here.
            self._active.pop(run_id, None)
            record = self.store.get_run(run_id)
            if record is not None:
                self.store.save_run(
                    record.model_copy(
                        update={"status": "cancelled", "error": reason, "updated_at": utc_now()}
                    )
                )
        active.task.cancel()
        return True

    async def drain(self) -> None:
        """Wait for in-flight background runs (used by tests)."""
        if self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def shutdown(self, grace_seconds: float = 5.0) -> None:
        """Let background runs finish briefly, then cancel the rest.

        Runs are in-process, so a stopped server cannot finish them. Cancelling
        records an honest terminal state instead of leaving them "running".
        """
        pending = [task for task in self._tasks if not task.done()]
        if pending:
            await asyncio.wait(pending, timeout=grace_seconds)
        for run_id in list(self._active):
            self.cancel(run_id, reason="server shut down before the run finished")
        await self.drain()