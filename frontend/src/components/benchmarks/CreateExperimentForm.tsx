import { FlaskConical, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useCreateBenchmarkExperiment } from "@/api/benchmarkQueries";
import { ApiError } from "@/api/client";
import type { BenchmarkCreateRequest, BenchmarkSuite, BenchmarkSuites } from "@/api/types";
import { Section, ToneBadge } from "@/components/execution/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Provider = NonNullable<BenchmarkCreateRequest["provider"]>;

/**
 * The provider values the create contract accepts (typed against the
 * generated schema, so a contract change fails to compile). The suites
 * response does not list providers; the server still decides what it can
 * use and refuses (400) what it cannot. No endpoint or model is shown.
 */
const PROVIDERS: Record<Provider, string> = {
  auto: "Server default",
  demo: "Demo fixture (scripted)",
  openai: "Configured model endpoint",
};
const PROVIDER_ORDER: Provider[] = ["auto", "demo", "openai"];

const SEED_MAX = 2 ** 31 - 1;

const inputClass =
  "h-9 rounded-md border border-border bg-background/60 px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

interface Draft {
  suiteId: string;
  armIds: string[];
  taskIds: string[];
  repetitions: string;
  provider: Provider;
  seed: string;
}

function draftFor(suite: BenchmarkSuite | undefined): Draft {
  return {
    suiteId: suite?.id ?? "",
    armIds: [],
    taskIds: suite?.tasks.map((task) => task.id) ?? [],
    repetitions: "1",
    provider: "auto",
    seed: "",
  };
}

/**
 * What a draft schedules. `repetitions` counts measured repetitions; the
 * server adds `warmup_repetitions` warm-up repetitions per arm and task,
 * run first and excluded from every result. `runs` is every trial the
 * server will execute, the number it checks against `max_trials`.
 */
export function plannedTrials(armCount: number, taskCount: number, repetitions: number, warmups: number) {
  const pairs = armCount * taskCount;
  const measured = pairs * repetitions;
  const warmup = pairs * warmups;
  return { pairs, measured, warmup, runs: measured + warmup };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Problems with the draft, by field; empty when it may be sent. */
function validate(draft: Draft, suites: BenchmarkSuites): Partial<Record<keyof Draft | "trials", string>> {
  const problems: Partial<Record<keyof Draft | "trials", string>> = {};
  const suite = suites.suites.find((candidate) => candidate.id === draft.suiteId);
  if (!suite) problems.suiteId = "Choose a suite.";
  if (draft.armIds.length === 0) problems.armIds = "Choose at least one arm.";
  if (suite && draft.taskIds.length === 0) problems.taskIds = "Choose at least one task.";
  const repetitions = Number(draft.repetitions);
  if (!/^\d+$/.test(draft.repetitions) || repetitions < 1 || repetitions > suites.max_repetitions) {
    problems.repetitions = `Repetitions must be a whole number from 1 to ${suites.max_repetitions}.`;
  }
  if (draft.seed !== "" && (!/^\d+$/.test(draft.seed) || Number(draft.seed) > SEED_MAX)) {
    problems.seed = `The seed must be a whole number from 0 to ${SEED_MAX}, or empty for a random one.`;
  }
  if (suite?.requires_real_model && draft.provider === "demo") {
    problems.provider = "This suite needs a real model: the demo fixture only scripts the catalog tasks.";
  }
  const planned = plannedTrials(
    draft.armIds.length,
    draft.taskIds.length,
    problems.repetitions ? 1 : repetitions,
    suites.warmup_repetitions,
  );
  if (planned.runs > suites.max_trials) {
    problems.trials =
      `${plural(planned.runs, "run")} requested (${planned.measured} measured + ${planned.warmup} warm-up); ` +
      `this server allows at most ${suites.max_trials}.`;
  }
  return problems;
}

/** The request body: only fixed ids, a count, a provider choice and a seed. */
function requestFor(draft: Draft, suite: BenchmarkSuite): BenchmarkCreateRequest {
  const everyTask = suite.tasks.every((task) => draft.taskIds.includes(task.id));
  return {
    suite_id: suite.id,
    arm_ids: draft.armIds,
    repetitions: Number(draft.repetitions),
    provider: draft.provider,
    // All tasks is the server's default; send a subset only when one was chosen.
    ...(everyTask ? {} : { task_ids: suite.tasks.map((task) => task.id).filter((id) => draft.taskIds.includes(id)) }),
    ...(draft.seed === "" ? {} : { order_seed: Number(draft.seed) }),
  };
}

/**
 * Start a benchmark experiment from the options this server offers. Render
 * it only when the server's suites response says it accepts experiments
 * (can_create); it refuses to send otherwise.
 */
export function CreateExperimentForm({ suites }: { suites: BenchmarkSuites }) {
  const create = useCreateBenchmarkExperiment();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(() => draftFor(suites.suites[0]));
  const [showProblems, setShowProblems] = useState(false);

  const suite = suites.suites.find((candidate) => candidate.id === draft.suiteId);
  const problems = validate(draft, suites);
  const valid = Object.keys(problems).length === 0;
  const repetitions = Number(draft.repetitions) || 0;
  const planned = plannedTrials(draft.armIds.length, draft.taskIds.length, repetitions, suites.warmup_repetitions);
  const warmups = suites.warmup_repetitions;

  function update(change: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...change }));
    if (create.isError) create.reset();
  }

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setShowProblems(true);
    // Never send while one request is in flight, when the draft is invalid,
    // or if the server does not accept experiments.
    if (create.isPending || !valid || !suite || !suites.can_create) return;
    create.mutate(requestFor(draft, suite), {
      onSuccess: (detail) => navigate(`/benchmarks/${encodeURIComponent(detail.experiment.experiment_id)}`),
    });
  }

  const problem = (field: keyof typeof problems) =>
    showProblems && problems[field] ? (
      <p id={`problem-${field}`} className="text-xs text-status-failed">
        {problems[field]}
      </p>
    ) : null;

  return (
    <Section
      id="new-experiment"
      title="New experiment"
      description="Fixed suites and fixed arms only: no goals, files, models or limits can be set here."
    >
      <form noValidate onSubmit={submit} aria-label="New experiment" className="space-y-5">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Suite</legend>
          <div className="grid gap-2 md:grid-cols-2">
            {suites.suites.map((candidate) => (
              <label
                key={candidate.id}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                  candidate.id === draft.suiteId ? "border-primary/70 bg-primary/5" : "border-border hover:bg-accent/30",
                )}
              >
                <input
                  type="radio"
                  name="suite"
                  value={candidate.id}
                  checked={candidate.id === draft.suiteId}
                  // A new suite starts with all of its tasks; arms and the rest carry over.
                  onChange={() => update({ suiteId: candidate.id, taskIds: candidate.tasks.map((task) => task.id) })}
                  className="mt-1 size-4 accent-[var(--primary)]"
                />
                <span className="min-w-0 space-y-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{candidate.title}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{candidate.version}</span>
                    {candidate.requires_real_model && (
                      <ToneBadge tone="findings" pulse={false}>
                        needs a real model
                      </ToneBadge>
                    )}
                  </span>
                  <span className="block text-xs text-muted-foreground">{candidate.description}</span>
                </span>
              </label>
            ))}
          </div>
          {problem("suiteId")}
        </fieldset>

        {suite && (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">Tasks</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {suite.tasks.map((task) => (
                <label key={task.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.taskIds.includes(task.id)}
                    onChange={() => update({ taskIds: toggle(draft.taskIds, task.id) })}
                    className="size-4 accent-[var(--primary)]"
                  />
                  <span>{task.title}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{task.id}</span>
                </label>
              ))}
            </div>
            {problem("taskIds")}
          </fieldset>
        )}

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Arms</legend>
          <div className="grid gap-2 md:grid-cols-2">
            {suites.arms.map((arm) => (
              <label key={arm.id} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.armIds.includes(arm.id)}
                  onChange={() => update({ armIds: toggle(draft.armIds, arm.id) })}
                  className="mt-0.5 size-4 accent-[var(--primary)]"
                />
                <span className="min-w-0">
                  <span className="font-medium">{arm.label}</span>{" "}
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {arm.id} · {arm.kind === "execution" ? "execution" : "model policy"}
                  </span>
                  <span className="block text-xs text-muted-foreground">{arm.description}</span>
                </span>
              </label>
            ))}
          </div>
          {problem("armIds")}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="experiment-repetitions" className="font-medium">
              Measured repetitions
            </label>
            <input
              id="experiment-repetitions"
              type="number"
              inputMode="numeric"
              min={1}
              max={suites.max_repetitions}
              value={draft.repetitions}
              onChange={(event) => update({ repetitions: event.target.value })}
              aria-invalid={showProblems && Boolean(problems.repetitions)}
              aria-describedby={["repetitions-help", problems.repetitions ? "problem-repetitions" : ""].join(" ").trim()}
              className={inputClass}
            />
            <span id="repetitions-help" className="text-xs text-muted-foreground">
              Per arm and task, at most {suites.max_repetitions}.
              {warmups > 0 && ` Plus ${plural(warmups, "warm-up run")} each, not counted.`}
            </span>
            {problem("repetitions")}
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Provider</span>
            <select
              value={draft.provider}
              onChange={(event) => update({ provider: event.target.value as Provider })}
              aria-invalid={showProblems && Boolean(problems.provider)}
              aria-describedby={problems.provider ? "problem-provider" : undefined}
              className={inputClass}
            >
              {PROVIDER_ORDER.map((provider) => (
                <option key={provider} value={provider}>
                  {PROVIDERS[provider]}
                </option>
              ))}
            </select>
            {problem("provider")}
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Order seed (optional)</span>
            <input
              type="text"
              inputMode="numeric"
              placeholder="random"
              value={draft.seed}
              onChange={(event) => update({ seed: event.target.value.trim() })}
              aria-invalid={showProblems && Boolean(problems.seed)}
              aria-describedby={problems.seed ? "problem-seed" : undefined}
              className={inputClass}
            />
            {problem("seed")}
          </label>
        </div>

        <div aria-label="Planned trials" role="group" className="rounded-lg border border-border/70 bg-card/40 p-3 text-sm">
          <p className="font-mono text-xs" aria-live="polite">
            <span className="text-foreground">{plural(planned.measured, "measured trial")}</span>
            {warmups > 0 && <> + {plural(planned.warmup, "warm-up")}</>} ={" "}
            <span className="font-semibold text-foreground">{plural(planned.runs, "run")} to execute</span>{" "}
            <span className="text-muted-foreground">
              · at most {suites.max_trials} · run one at a time
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {warmups > 0
              ? `Each of the ${plural(planned.pairs, "arm and task pair")} first runs ${plural(warmups, "warm-up")}, excluded from every rate, distribution and timing. `
              : "This server runs no warm-up. "}
            Trials excluded later (cancelled, interrupted) are not rerun.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : <FlaskConical aria-hidden="true" />}
            {create.isPending ? "Starting…" : "Start experiment"}
          </Button>
          {problem("trials")}
          {create.isError && <CreateError error={create.error} />}
        </div>
      </form>
    </Section>
  );
}

/** What the server said, in terms the operator can act on. */
function CreateError({ error }: { error: Error }) {
  let title = "The experiment could not be started.";
  if (error instanceof ApiError) {
    if (error.status === 400) title = "The server refused this experiment.";
    else if (error.status === 403) title = "This server does not accept new experiments.";
    else if (error.status === 409) title = "Another experiment is already active. Wait for it to finish, then try again.";
    else if (error.status === 422) title = "The request was not valid.";
    else if (error.status === 429) {
      title = error.retryAfter ? `Busy right now. Try again in ${error.retryAfter} s.` : "Busy right now. Try again shortly.";
    } else if (error.status >= 500) title = "The server failed to start the experiment.";
  } else {
    title = "Could not reach the server. A sleeping free-tier backend can take up to a minute to wake; try again shortly.";
  }
  return (
    <div role="alert" className="basis-full text-sm">
      <p className="text-status-failed">{title}</p>
      {error instanceof ApiError && <p className="mt-0.5 text-xs text-muted-foreground">{error.message}</p>}
    </div>
  );
}
