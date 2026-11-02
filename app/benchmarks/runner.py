"""The benchmark experiment runner.

An experiment is a fixed plan of trials (arm x task x repetition) that the
runner executes one at a time through ``RunService``, the same path as any
other run, so every trial is an ordinary run with its own trace. There is no
second orchestration path.

Lifecycle (``BenchmarkExperiment.status``)::

    queued -> running -> completed   every trial ran
                      -> partial     some trials ran, some could not
                      -> failed      no trial ran, or the runner broke
                      -> cancelled   cancel() was called
                      -> interrupted the process stopped mid-experiment
    queued -> interrupted            found unstarted after a restart

Guarantees:

* All trial rows are persisted, in their execution order, before anything
  runs. The order comes from a stored seed (``plan_schedule``).
* Status changes are conditional updates: an experiment is claimed
  queued -> running once, a trial pending -> running once and finished once.
  A retried or concurrent attempt changes nothing, so no trial is ever run
  twice and no run is created twice for a trial.
* Before each trial its configuration is recomputed and compared with the
  stored fingerprint; if the server's configuration changed, the trial is an
  error rather than a run of something else.
* Waiting for a free run slot sleeps outside any database transaction.
* After a restart nothing is resumed: ``recover_interrupted`` closes what
  was running as interrupted, and its unstarted trials as not_run.
"""

from __future__ import annotations

import asyncio
import random
import secrets
from dataclasses import dataclass, field

from app.benchmarks.arms import ARMS, ArmError, get_arm
from app.benchmarks.metrics import trial_metrics
from app.benchmarks.models import BenchmarkExperiment, BenchmarkTrial, ExperimentOrigin
from app.benchmarks.provenance import ArmConfiguration, arm_configuration, collect_provenance
from app.benchmarks.store import BenchmarkStore
from app.benchmarks.suites import SuiteError, get_suite
from app.demo_tasks import DemoTaskError
from app.models import RunRequest, utc_now
from app.providers import ProviderConfigError
from app.service import CapacityError, PublicDemoError, RunService

MAX_REPETITIONS = 10
MAX_TRIALS = 60
# How often a trial waiting for a free run slot checks again.
SLOT_POLL_SECONDS = 0.5


class ExperimentError(ValueError):
    """The experiment cannot be created or run as requested."""


def plan_schedule(
    task_ids: list[str], arm_ids: list[str], repetitions: int, seed: int
) -> list[tuple[int, str, str]]:
    """The trials in execution order, as (repetition, task_id, arm_id).

    Each (repetition, task) block runs every arm back to back, so arms are
    compared under the same conditions. The arm order is a seeded
    permutation rotated by one position per block: across consecutive
    blocks every arm runs in every position equally often, so no arm always
    goes first (a warm cache) or last (a loaded machine). Same seed, same
    order.
    """
    base = list(arm_ids)
    random.Random(seed).shuffle(base)
    order: list[tuple[int, str, str]] = []
    block = 0
    for repetition in range(repetitions):
        for task_id in task_ids:
            shift = block % len(base)
            order.extend((repetition, task_id, arm) for arm in base[shift:] + base[:shift])
            block += 1
    return order


@dataclass
class _Running:
    experiment_id: str
    cancel_requested: bool = False
    run_id: str | None = None
    task: asyncio.Task | None = field(default=None, repr=False)


class ExperimentRunner:
    def __init__(
        self,
        service: RunService,
        benchmarks: BenchmarkStore,
        *,
        slot_poll_seconds: float = SLOT_POLL_SECONDS,
    ) -> None:
        self.service = service
        self.benchmarks = benchmarks
        self.slot_poll_seconds = slot_poll_seconds
        self._running: dict[str, _Running] = {}
        self._tasks: set[asyncio.Task] = set()

    @property
    def settings(self):
        return self.service.settings

    # ------------------------------------------------------------------
    # create
    # ------------------------------------------------------------------
    def create(
        self,
        suite_id: str,
        arm_ids: list[str],
        repetitions: int = 1,
        *,
        origin: ExperimentOrigin,
        provider: str = "auto",
        task_ids: list[str] | None = None,
        order_seed: int | None = None,
        budget_usd: float | None = None,
    ) -> BenchmarkExperiment:
        """Validate and persist an experiment with all its trials (queued)."""
        try:
            suite = get_suite(suite_id)
        except SuiteError as exc:
            raise ExperimentError(str(exc)) from exc
        if self.settings.is_public_demo:
            if not suite.public:
                raise ExperimentError(f"suite {suite.id!r} is not available in the public demo")
            if provider != "auto":
                raise ExperimentError("the public demo uses the server's provider")

        if not arm_ids:
            raise ExperimentError("choose at least one arm")
        if len(set(arm_ids)) != len(arm_ids):
            raise ExperimentError("each arm may be chosen once")
        try:
            arms = [get_arm(arm_id) for arm_id in arm_ids]
        except ArmError as exc:
            raise ExperimentError(f"{exc}; arms are {sorted(ARMS)}") from exc
        if not 1 <= repetitions <= MAX_REPETITIONS:
            raise ExperimentError(f"repetitions must be between 1 and {MAX_REPETITIONS}")

        tasks = list(suite.tasks)
        if task_ids is not None:
            try:
                tasks = [suite.task(task_id) for task_id in dict.fromkeys(task_ids)]
            except SuiteError as exc:
                raise ExperimentError(str(exc)) from exc
            if not tasks:
                raise ExperimentError("choose at least one task")
        total = len(arms) * len(tasks) * repetitions
        if total > MAX_TRIALS:
            raise ExperimentError(f"{total} trials requested; the limit is {MAX_TRIALS}")

        try:
            provenance = collect_provenance(self.settings, provider)
            configurations = [
                arm_configuration(arm, task, self.settings, provider, budget_usd)
                for arm in arms
                for task in tasks
            ]
        except ProviderConfigError as exc:
            raise ExperimentError(str(exc)) from exc
        if suite.requires_real_model and provenance.scripted:
            raise ExperimentError(
                f"suite {suite.id!r} needs a real model: the demo fixture only scripts "
                "the catalog recipes"
            )

        seed = order_seed if order_seed is not None else secrets.randbelow(2**31)
        experiment = BenchmarkExperiment(
            origin=origin,
            suite_id=suite.id,
            suite_version=suite.version,
            provider=provenance.provider,
            provider_kind=provenance.provider_kind,
            scripted=provenance.scripted,
            repetitions=repetitions,
            order_seed=seed,
            arm_ids=list(arm_ids),
            configurations=configurations,
            provenance=provenance,
        )
        fingerprints = {(c.arm_id, c.task_id): c.fingerprint for c in configurations}
        schedule = plan_schedule([t.id for t in tasks], list(arm_ids), repetitions, seed)
        trials = [
            BenchmarkTrial(
                experiment_id=experiment.experiment_id,
                ordinal=ordinal,
                arm_id=arm_id,
                task_id=task_id,
                repetition=repetition,
                fingerprint=fingerprints[(arm_id, task_id)],
            )
            for ordinal, (repetition, task_id, arm_id) in enumerate(schedule)
        ]
        self.benchmarks.create_experiment(experiment, trials, exclusive=True)
        return experiment

    # ------------------------------------------------------------------
    # run
    # ------------------------------------------------------------------
    async def run(self, experiment_id: str) -> BenchmarkExperiment:
        """Execute a queued experiment's trials in order; returns it finished.

        Raises ExperimentError when the experiment is unknown or not queued
        (already run, running elsewhere, or closed by recovery).
        """
        experiment = self.benchmarks.get_experiment(experiment_id)
        if experiment is None:
            raise ExperimentError(f"unknown experiment: {experiment_id}")
        claimed = self.benchmarks.transition_experiment(
            experiment.model_copy(update={"status": "running", "started_at": utc_now()}),
            ("queued",),
        )
        if claimed is None:
            raise ExperimentError(f"experiment {experiment_id} is {experiment.status}, not queued")
        state = _Running(experiment_id)
        self._running[experiment_id] = state
        try:
            for trial in self.benchmarks.get_trials(experiment_id):
                if state.cancel_requested:
                    break
                if trial.status == "pending":
                    await self._run_trial(claimed, trial, state)
        except asyncio.CancelledError:
            reason = "the runner stopped before the experiment finished"
            self._abandon_running_trials(experiment_id, reason)
            self._close(claimed, "interrupted", reason)
            raise
        except Exception as exc:  # noqa: BLE001 - never leave an experiment running
            reason = f"{type(exc).__name__}: {exc}"
            self._abandon_running_trials(experiment_id, f"the runner failed: {reason}")
            return self._close(claimed, "failed", reason)
        finally:
            self._running.pop(experiment_id, None)
        if state.cancel_requested:
            return self._close(claimed, "cancelled", "cancelled on request")
        return self._close(claimed, None, None)

    def _close(
        self, experiment: BenchmarkExperiment, status: str | None, reason: str | None
    ) -> BenchmarkExperiment:
        """Finish the experiment: unstarted trials become not_run, and the
        status is the one given or, when None, follows from the trials."""
        self.benchmarks.mark_unstarted(
            experiment.experiment_id, reason or "the experiment ended before this trial"
        )
        trials = self.benchmarks.get_trials(experiment.experiment_id)
        if status is None:
            done = sum(1 for trial in trials if trial.status == "done")
            if done == len(trials):
                status = "completed"
            elif done == 0:
                status = "failed"
                errors = [trial.error for trial in trials if trial.error]
                reason = errors[0] if errors else "no trial ran"
            else:
                status = "partial"
                reason = f"{len(trials) - done} of {len(trials)} trials did not run"
        closed = experiment.model_copy(
            update={"status": status, "finished_at": utc_now(), "error": reason}
        )
        saved = self.benchmarks.transition_experiment(closed, ("running",))
        return saved or self.benchmarks.get_experiment(experiment.experiment_id) or closed

    async def _run_trial(
        self, experiment: BenchmarkExperiment, trial: BenchmarkTrial, state: _Running
    ) -> None:
        running = trial.model_copy(update={"status": "running", "started_at": utc_now()})
        if not self.benchmarks.transition_trial(running, "pending"):
            return  # claimed by someone else: never run a trial twice

        try:
            request = self._request(experiment, running)
        except ExperimentError as exc:
            self._fail_trial(running, str(exc))
            return

        started = await self._start_when_free(request, state)
        if started is None:
            # Cancelled before its run started: the trial never ran.
            self.benchmarks.transition_trial(trial, "running")
            return
        if isinstance(started, str):
            self._fail_trial(running, started)
            return
        record, task = started
        state.run_id, state.task = record.run_id, task
        linked = running.model_copy(update={"run_id": record.run_id})
        self.benchmarks.save_trial(linked)
        try:
            # Wait for the run without letting our own cancellation cancel it:
            # the run is cancelled through the service, which records it.
            await asyncio.wait({task})
        finally:
            state.run_id, state.task = None, None
        self._finish_trial(linked)

    def _request(self, experiment: BenchmarkExperiment, trial: BenchmarkTrial) -> RunRequest:
        """The run request for a trial, exactly as configured at creation."""
        stored = self._configuration(experiment, trial)
        suite = get_suite(experiment.suite_id)
        try:
            task = suite.task(trial.task_id)
            arm = get_arm(trial.arm_id)
            current = arm_configuration(
                arm,
                task,
                self.settings,
                experiment.provenance.provider_choice,
                stored.limits.max_budget_usd,
            )
        except (SuiteError, ArmError, ProviderConfigError) as exc:
            raise ExperimentError(str(exc)) from exc
        if current.fingerprint != trial.fingerprint:
            raise ExperimentError(
                "the server's configuration changed since the experiment was created "
                "(provider, models or limits), so this trial would not run as recorded"
            )
        return RunRequest(
            goal=task.goal,
            demo_task=task.demo_task,  # type: ignore[arg-type]
            provider=experiment.provenance.provider_choice,  # type: ignore[arg-type]
            model_policy=arm.model_policy,
            limits=stored.limits,
        )

    @staticmethod
    def _configuration(experiment: BenchmarkExperiment, trial: BenchmarkTrial) -> ArmConfiguration:
        for config in experiment.configurations:
            if config.arm_id == trial.arm_id and config.task_id == trial.task_id:
                return config
        raise ExperimentError(f"no stored configuration for {trial.arm_id} on {trial.task_id}")

    async def _start_when_free(self, request: RunRequest, state: _Running):
        """Start the run once a run slot is free; returns (record, task), a
        reason the run could not be started, or None when the experiment was
        cancelled first. Waits outside any transaction."""
        while True:
            if state.cancel_requested:
                return None
            try:
                return self.service.start(request)
            except CapacityError:
                # Every slot is taken (by visitors' runs, say): wait, never fail.
                await asyncio.sleep(self.slot_poll_seconds)
            except (PublicDemoError, ProviderConfigError, DemoTaskError) as exc:
                return f"the run could not be started: {exc}"

    def _finish_trial(self, trial: BenchmarkTrial) -> None:
        record = self.service.store.get_run(trial.run_id or "")
        if record is None:
            self._fail_trial(trial, "the trial's run is missing")
            return
        metrics = trial_metrics(record, self.service.store.get_events(record.run_id))
        finished = trial.model_copy(
            update={"status": "done", "finished_at": utc_now(), "metrics": metrics}
        )
        self.benchmarks.transition_trial(finished, "running")

    def _abandon_running_trials(self, experiment_id: str, reason: str) -> None:
        """Close trials left running when the runner stops: keep the metrics
        of a run that finished; otherwise cancel the run (the service records
        it as cancelled) and mark the trial an error."""
        for trial in self.benchmarks.get_trials(experiment_id):
            if trial.status != "running":
                continue
            try:
                record = self.service.store.get_run(trial.run_id) if trial.run_id else None
                if record is not None and record.status not in {"queued", "running"}:
                    self._finish_trial(trial)
                    continue
                if trial.run_id is not None:
                    self.service.cancel(trial.run_id, reason=reason)
            except Exception as exc:  # noqa: BLE001 - this is the cleanup path
                reason = f"{reason}; its result could not be recorded ({type(exc).__name__}: {exc})"
            self._fail_trial(trial, reason)

    def _fail_trial(self, trial: BenchmarkTrial, reason: str) -> None:
        failed = trial.model_copy(
            update={"status": "error", "finished_at": utc_now(), "error": reason}
        )
        self.benchmarks.transition_trial(failed, "running")

    # ------------------------------------------------------------------
    # cancel and recover
    # ------------------------------------------------------------------
    def cancel(self, experiment_id: str) -> bool:
        """Cancel an experiment running in this process: its current run is
        cancelled (and recorded as cancelled), the rest never start.
        Returns False when it is not running here."""
        state = self._running.get(experiment_id)
        if state is None:
            return False
        state.cancel_requested = True
        if state.run_id is not None:
            self.service.cancel(state.run_id, reason="benchmark experiment cancelled")
        return True

    def is_running(self, experiment_id: str) -> bool:
        return experiment_id in self._running

    def launch(self, experiment_id: str) -> asyncio.Task:
        """Run a queued experiment in the background (the API's way to run one)."""
        task = asyncio.create_task(self.run(experiment_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def shutdown(self) -> None:
        """Stop background experiments: each ends interrupted, its current run
        cancelled. Call before the run service shuts down."""
        tasks = [task for task in self._tasks if not task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def recover_interrupted(self) -> list[str]:
        """Close experiments a stopped process left queued or running.

        Call at startup, after the run store's own recovery and before any
        runner works on this database. Nothing is resumed: a trial whose run
        finished keeps its metrics (the run itself was closed by run
        recovery), a trial that never got a run is an error, and unstarted
        trials become not_run.
        """
        recovered: list[str] = []
        for experiment in self.benchmarks.active_experiments():
            if self.is_running(experiment.experiment_id):
                continue
            for trial in self.benchmarks.get_trials(experiment.experiment_id):
                if trial.status != "running":
                    continue
                record = self.service.store.get_run(trial.run_id) if trial.run_id else None
                if record is not None and record.status not in {"queued", "running"}:
                    self._finish_trial(trial)
                else:
                    self._fail_trial(trial, "the server stopped while this trial was running")
            reason = "the server stopped before the experiment finished"
            self.benchmarks.mark_unstarted(experiment.experiment_id, reason)
            closed = experiment.model_copy(
                update={"status": "interrupted", "finished_at": utc_now(), "error": reason}
            )
            if self.benchmarks.transition_experiment(closed, ("queued", "running")):
                recovered.append(experiment.experiment_id)
        return recovered
