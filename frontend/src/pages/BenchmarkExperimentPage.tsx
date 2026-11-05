import { ArrowLeft, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { isActiveExperiment, useBenchmarkExperiment } from "@/api/benchmarkQueries";
import { ApiError } from "@/api/client";
import type {
  BenchmarkAggregate,
  BenchmarkExperimentDetail,
  BenchmarkTrial,
  BenchmarkTrialMetrics,
} from "@/api/types";
import { ExperimentStatusBadge, ProvenanceBadge } from "@/components/benchmarks/badges";
import {
  TimingAggregateTable,
  TrialTimingPanel,
  formatTiming,
  measurementStatusText,
  trialTimingState,
} from "@/components/benchmarks/timings";
import { formatDate, formatDuration, humanize } from "@/components/execution/format";
import { EmptyLine, Section, ToneBadge, Unknown, Value, type Tone } from "@/components/execution/primitives";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * One benchmark experiment, exactly as the backend reports it: its
 * provenance, each arm's configuration, identical-by-design warnings, the
 * backend's aggregates and every trial with its run. Nothing is computed
 * here beyond formatting; a value the backend leaves null is shown as
 * unknown (with the backend's reason when it gives one), never as zero.
 * The experiment is refetched every 2 s while queued or running.
 */
export function BenchmarkExperimentPage() {
  const { experimentId } = useParams();
  const detail = useBenchmarkExperiment(experimentId);

  if (detail.isPending) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading experiment">
        {detail.failureCount > 0 && (
          <p role="status" className="text-sm text-status-live">
            Waking the server… a free-tier backend can take up to a minute after a quiet period.
          </p>
        )}
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  const data = detail.data;
  // A failed poll keeps the last data (TanStack reports it as an error with
  // data): only a failed first load replaces the page.
  if (!data) {
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return (
        <div className="space-y-2">
          <BackLink />
          <h1 className="text-xl font-semibold">Experiment not found</h1>
          <p className="text-muted-foreground">
            No experiment <code>{experimentId}</code> on this server.
          </p>
        </div>
      );
    }
    return (
      <div className="space-y-3">
        <BackLink />
        <div role="alert" className="glass flex flex-wrap items-center gap-3 rounded-xl p-4">
          <p className="text-status-failed">Could not load this experiment: {detail.error?.message ?? "unknown error"}</p>
          <Button variant="outline" size="sm" onClick={() => void detail.refetch()} disabled={detail.isFetching}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <BackLink />
      <Header data={data} refreshError={detail.isError ? detail.error : null} />
      {data.notes.length > 0 && (
        <ul role="note" aria-label="About these results" className="glass space-y-1 rounded-xl px-4 py-3 text-sm text-muted-foreground">
          {data.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <Overview data={data} />
      <Provenance data={data} />
      <Configurations data={data} />
      <IdenticalByDesign data={data} />
      <Aggregates
        id="arm-aggregates"
        title="Results by arm"
        description={
          <>
            Over every task. Rates, means and timings count only measured trials: finished, not a warm-up, not excluded.
            Cancellation and interrupted rates are over every non-warm-up trial. Medians and nearest-rank P95s describe the
            measured trials; twenty trials per arm and task do not establish a statistically significant difference.
          </>
        }
        aggregates={data.aggregates}
      />
      <Aggregates
        id="task-aggregates"
        title="Results by arm and task"
        description="The same, for each task separately. The sample requirement applies here, to each arm and task."
        aggregates={data.task_aggregates}
      />
      <Trials trials={data.trials} warmups={data.experiment.warmup_repetitions} />
      <TrialTimings trials={data.trials} warmups={data.experiment.warmup_repetitions} />
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/benchmarks" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft aria-hidden="true" className="size-4" />
      Benchmarks
    </Link>
  );
}

// ----------------------------------------------------------------------
// header, overview, provenance
// ----------------------------------------------------------------------
function Header({ data, refreshError }: { data: BenchmarkExperimentDetail; refreshError: Error | null }) {
  const experiment = data.experiment;
  const active = isActiveExperiment(experiment.status);
  return (
    <header className="glass space-y-2 rounded-xl p-4 sm:p-5">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand-cyan">Benchmark experiment</p>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{experiment.suite_title}</h1>
        <ExperimentStatusBadge status={experiment.status} />
        <ProvenanceBadge scripted={experiment.scripted} />
        {active && (
          <ToneBadge tone="muted" pulse={false}>
            refreshing every 2 s
          </ToneBadge>
        )}
      </div>
      <p className="font-mono text-xs text-muted-foreground">{experiment.experiment_id}</p>
      {experiment.error && <p className="text-sm text-muted-foreground">{experiment.error}</p>}
      {refreshError && (
        <p role="status" className="text-xs text-status-failed">
          Could not refresh ({refreshError.message}); showing the last data received.
        </p>
      )}
    </header>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="wrap-break-word font-mono text-sm">{children}</dd>
    </div>
  );
}

function Overview({ data }: { data: BenchmarkExperimentDetail }) {
  const experiment = data.experiment;
  const active = isActiveExperiment(experiment.status);
  const elapsed = elapsedMs(experiment.started_at, experiment.finished_at);
  return (
    <Section id="overview" title="Overview">
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="suite">
          {experiment.suite_id} <span className="text-muted-foreground">{experiment.suite_version}</span>
        </Fact>
        <Fact label="arms">{experiment.arm_ids.join(", ")}</Fact>
        <Fact label="repetitions">{experiment.repetitions}</Fact>
        <Fact label="trials done">
          {experiment.trials_done} of {experiment.trials_total}
        </Fact>
        <Fact label="created">
          <Value value={formatDate(experiment.created_at)} />
        </Fact>
        <Fact label="started">
          {experiment.started_at ? formatDate(experiment.started_at) : <Unknown>{active ? "not yet" : "not recorded"}</Unknown>}
        </Fact>
        <Fact label="finished">
          {experiment.finished_at ? formatDate(experiment.finished_at) : active ? "in progress" : <Unknown />}
        </Fact>
        <Fact label="took">{active ? "in progress" : <Value value={formatDuration(elapsed)} />}</Fact>
        <Fact label="started by">{experiment.origin === "api" ? "API" : "CLI"}</Fact>
        <Fact label="trial order seed">{data.order_seed}</Fact>
      </dl>
    </Section>
  );
}

const yesNo = (value: boolean) => (value ? "yes" : "no");

function Provenance({ data }: { data: BenchmarkExperimentDetail }) {
  const environment = data.environment;
  return (
    <Section
      id="provenance"
      title="Provenance"
      description="Where and how the experiment ran, as recorded when it was created."
    >
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="provider">
          {environment.provider} <span className="text-muted-foreground">({environment.provider_kind})</span>
        </Fact>
        <Fact label="results">{environment.scripted ? "scripted provider" : "real model"}</Fact>
        <Fact label="token pricing known">{yesNo(environment.pricing_known)}</Fact>
        <Fact label="cost enforced">{yesNo(environment.monetary_enforced)}</Fact>
        <Fact label="test execution">
          {environment.execution_enabled ? `enabled · ${environment.execution_sandbox} sandbox` : "disabled"}
        </Fact>
        <Fact label="verification command">{environment.verification_command}</Fact>
        <Fact label="app version">{environment.app_version}</Fact>
        <Fact label="build commit">
          <Value value={environment.build_commit} />
        </Fact>
        <Fact label="python">
          <Value value={environment.python_version} missing="not disclosed" />
        </Fact>
        <Fact label="platform">
          <Value value={environment.platform} missing="not disclosed" />
        </Fact>
        <Fact label="mode">{humanize(environment.mode)}</Fact>
        <Fact label="recorded">
          <Value value={formatDate(environment.collected_at)} />
        </Fact>
      </dl>
    </Section>
  );
}

// ----------------------------------------------------------------------
// configurations and identical-by-design
// ----------------------------------------------------------------------
function Configurations({ data }: { data: BenchmarkExperimentDetail }) {
  return (
    <Section
      id="configurations"
      title="Arm configurations"
      description="What each arm ran with on each task: models per role, whether escalation was possible, and the effective limits."
    >
      {data.configurations.length === 0 ? (
        <EmptyLine>No configuration was recorded.</EmptyLine>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-left text-xs">
            <caption className="sr-only">Arm configurations</caption>
            <thead className="text-muted-foreground">
              <tr className="border-b border-border/60">
                <th scope="col" className="py-2 pr-3 font-normal">arm</th>
                <th scope="col" className="py-2 pr-3 font-normal">task</th>
                <th scope="col" className="py-2 pr-3 font-normal">policy</th>
                <th scope="col" className="py-2 pr-3 font-normal">models</th>
                <th scope="col" className="py-2 pr-3 font-normal">escalation</th>
                <th scope="col" className="py-2 pr-3 font-normal">parallel coding matters</th>
                <th scope="col" className="py-2 pr-3 font-normal">limits</th>
                <th scope="col" className="py-2 font-normal">fingerprint</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {data.configurations.map((config) => (
                <tr key={`${config.arm_id}/${config.task_id}`} className="border-b border-border/30 align-top">
                  <td className="py-2 pr-3">{config.arm_id}</td>
                  <td className="py-2 pr-3">{config.task_id}</td>
                  <td className="py-2 pr-3">{config.model_policy}</td>
                  <td className="py-2 pr-3">
                    {Object.entries(config.models_by_role).map(([role, model]) => (
                      <div key={role}>
                        {role}: {model}
                      </div>
                    ))}
                  </td>
                  <td className="py-2 pr-3">
                    {config.escalation_possible ? (
                      "possible"
                    ) : (
                      <>
                        not possible
                        {config.escalation_unavailable.map((reason) => (
                          <div key={reason} className="font-sans text-muted-foreground">
                            {reason}
                          </div>
                        ))}
                      </>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {config.parallel_relevant === null ? <Unknown>unknown</Unknown> : yesNo(config.parallel_relevant)}
                  </td>
                  <td className="py-2 pr-3">
                    {config.limits.max_agent_calls} calls · {config.limits.max_wall_seconds} s · {config.limits.max_retries}{" "}
                    retries · {config.limits.max_revisions} revisions · {config.limits.max_escalations} escalations ·{" "}
                    {config.limits.parallel_coding ? "parallel" : "sequential"}
                  </td>
                  <td className="py-2" title={config.fingerprint}>
                    {config.fingerprint}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function IdenticalByDesign({ data }: { data: BenchmarkExperimentDetail }) {
  return (
    <Section
      id="identical-by-design"
      title="Identical by design"
      description="Arms whose effective configuration on a task is the same, according to the recorded configuration fingerprints."
    >
      {data.identical_by_design.length === 0 ? (
        <EmptyLine>No arms ran identically by construction on any task.</EmptyLine>
      ) : (
        <ul className="space-y-3">
          {data.identical_by_design.map((group) => (
            <li
              key={`${group.task_id}/${group.fingerprint}`}
              className="rounded-lg border border-status-findings/30 bg-status-findings/5 p-3 text-sm"
            >
              <p className="font-medium">
                {group.arm_ids.join(", ")} <span className="font-normal text-muted-foreground">on</span> {group.task_id}
              </p>
              <p className="mt-1 text-muted-foreground">{group.explanation}</p>
              <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                {group.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ----------------------------------------------------------------------
// aggregates
// ----------------------------------------------------------------------
const percent = (rate: number) => `${Math.round(rate * 1000) / 10}%`;
const decimal = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2));

function Rate({ count, rate, counted }: { count: number; rate: number | null; counted: number }) {
  if (rate === null) return <Unknown>no counted trials</Unknown>;
  return (
    <>
      {percent(rate)} <span className="text-muted-foreground">({count} of {counted})</span>
    </>
  );
}

function Mean({ value, missing = "not established" }: { value: number | null; missing?: string }) {
  return value === null ? <Unknown>{missing}</Unknown> : <>{decimal(value)}</>;
}

function Duration({ distribution }: { distribution: BenchmarkAggregate["latency_ms"] }) {
  if (distribution.n === 0 || distribution.median === null) return <Unknown>none recorded</Unknown>;
  return (
    <>
      median {formatDuration(distribution.median)}
      {distribution.p95 !== null && <> · p95 {formatDuration(distribution.p95)}</>}{" "}
      <span className="text-muted-foreground">(n={distribution.n})</span>
    </>
  );
}

function Aggregates({
  id,
  title,
  description,
  aggregates,
}: {
  id: string;
  title: string;
  description: ReactNode;
  aggregates: BenchmarkAggregate[];
}) {
  return (
    <Section id={id} title={title} description={description}>
      {aggregates.length === 0 ? (
        <EmptyLine>No results yet.</EmptyLine>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {aggregates.map((aggregate) => (
            <AggregateCard key={`${aggregate.arm_id}/${aggregate.task_id ?? "*"}`} aggregate={aggregate} />
          ))}
        </ul>
      )}
    </Section>
  );
}

/** A count's share of a stated denominator; unknown (not 0%) when the denominator is 0. */
function Share({ count, rate, of, ofLabel }: { count: number; rate: number | null; of: number; ofLabel: string }) {
  if (rate === null) return <Unknown>no {ofLabel}</Unknown>;
  return (
    <>
      {percent(rate)}{" "}
      <span className="text-muted-foreground">
        ({count} of {of} {ofLabel})
      </span>
    </>
  );
}

/** Whether the measured sample meets the backend's requirement (per arm and task). */
function SampleStatus({ aggregate }: { aggregate: BenchmarkAggregate }) {
  const overall = aggregate.task_id === null;
  if (aggregate.sample_complete) {
    return (
      <ToneBadge tone="completed" pulse={false}>
        complete sample · {overall ? `every task has ${aggregate.sample_required}+ measured` : `${aggregate.counted} measured`}
      </ToneBadge>
    );
  }
  return (
    <ToneBadge tone="findings" pulse={false}>
      incomplete sample ·{" "}
      {overall
        ? `${aggregate.sample_required} measured per task needed`
        : `${aggregate.counted} of ${aggregate.sample_required} measured`}
    </ToneBadge>
  );
}

function AggregateCard({ aggregate }: { aggregate: BenchmarkAggregate }) {
  const name = aggregate.task_id ? `${aggregate.arm_id} on ${aggregate.task_id}` : aggregate.arm_id;
  return (
    <li aria-label={`Results for ${name}`} className="rounded-lg border border-border/70 bg-card/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">
          {aggregate.arm_id}
          {aggregate.task_id && <span className="font-mono text-xs text-muted-foreground"> · {aggregate.task_id}</span>}
        </p>
        <SampleStatus aggregate={aggregate} />
      </div>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
        <span className="text-foreground">measured n = {aggregate.counted}</span> · {aggregate.warmups} warm-up
        {aggregate.warmups === 1 ? "" : "s"} · {aggregate.excluded} excluded · {aggregate.incomplete} incomplete ·{" "}
        {aggregate.trials} trial{aggregate.trials === 1 ? "" : "s"} with results ·{" "}
        {Object.entries(aggregate.trial_statuses)
          .map(([status, count]) => `${count} ${humanize(status)}`)
          .join(", ")}
      </p>
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        <Fact label="cancelled">
          <Share count={aggregate.cancelled} rate={aggregate.cancellation_rate} of={aggregate.non_warmup_trials} ofLabel="non-warm-up trials" />
        </Fact>
        <Fact label="interrupted">
          <Share count={aggregate.interrupted} rate={aggregate.interrupted_rate} of={aggregate.non_warmup_trials} ofLabel="non-warm-up trials" />
        </Fact>
        <Fact label="task success (run completed)">
          <Rate count={aggregate.task_successes} rate={aggregate.task_success_rate} counted={aggregate.counted} />
        </Fact>
        <Fact label="verification passed">
          <Rate count={aggregate.verification_passes} rate={aggregate.verification_pass_rate} counted={aggregate.counted} />
        </Fact>
        <Fact label="run latency">
          <Duration distribution={aggregate.latency_ms} />
        </Fact>
        <Fact label="model-call latency">
          <Duration distribution={aggregate.model_latency_ms} />
        </Fact>
        <Fact label="verification time">
          <Duration distribution={aggregate.verification_ms} />
        </Fact>
        <Fact label="mean agent calls">
          <Mean value={aggregate.mean_agent_calls} />
        </Fact>
        <Fact label="mean retries (step / call)">
          <Mean value={aggregate.mean_retries} />{" "}
          <span className="text-muted-foreground">
            (<Mean value={aggregate.mean_step_retries} /> / <Mean value={aggregate.mean_call_retries} />)
          </span>
        </Fact>
        <Fact label="mean revisions · repair rounds · escalations">
          <Mean value={aggregate.mean_revisions} /> · <Mean value={aggregate.mean_repair_rounds} /> ·{" "}
          <Mean value={aggregate.mean_escalations} />
        </Fact>
        <Fact label={`mean tokens in / out (${aggregate.runs_with_usage} with usage)`}>
          {aggregate.mean_input_tokens === null ? (
            <Unknown>no run reported usage</Unknown>
          ) : (
            <>
              {decimal(aggregate.mean_input_tokens)} / <Mean value={aggregate.mean_output_tokens} />
            </>
          )}
        </Fact>
        <Fact label={`cost (${aggregate.runs_with_cost} with cost)`}>
          {aggregate.total_cost_usd === null ? (
            <Unknown>not established</Unknown>
          ) : (
            <>
              ${aggregate.total_cost_usd} total · <Mean value={aggregate.mean_cost_usd} /> mean
            </>
          )}
        </Fact>
      </dl>
      {aggregate.excluded > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Excluded:{" "}
          {Object.entries(aggregate.excluded_reasons)
            .map(([reason, count]) => `${reason} (${count})`)
            .join("; ")}
        </p>
      )}
      <details className="mt-3 rounded-md border border-border/50 px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          Run timings{" "}
          <span className="font-normal text-muted-foreground">
            · {aggregate.timings.measured} of {aggregate.counted} counted measured
          </span>
        </summary>
        <div className="mt-2">
          <TimingAggregateTable timings={aggregate.timings} counted={aggregate.counted} />
        </div>
      </details>
      {aggregate.notes.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          {aggregate.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ----------------------------------------------------------------------
// trials
// ----------------------------------------------------------------------
const TRIAL_STATUS: Record<BenchmarkTrial["status"], { tone: Tone; label: string }> = {
  pending: { tone: "muted", label: "pending" },
  running: { tone: "live", label: "running" },
  done: { tone: "completed", label: "done" },
  not_run: { tone: "cancelled", label: "not run" },
  error: { tone: "failed", label: "error" },
};

const OUTCOME: Record<BenchmarkTrialMetrics["outcome"], { tone: Tone; label: string }> = {
  success: { tone: "completed", label: "task succeeded" },
  failure: { tone: "failed", label: "task failed" },
  excluded: { tone: "cancelled", label: "excluded" },
  incomplete: { tone: "muted", label: "incomplete" },
};

/** A metric the backend may leave null; unknown carries the backend's reason. */
function Metric({
  metrics,
  field,
  children,
}: {
  metrics: BenchmarkTrialMetrics;
  field: string;
  children: ReactNode | null;
}) {
  if (children !== null) return <>{children}</>;
  const reason = metrics.null_reasons[field] ?? metrics.null_reasons["*"];
  return <Unknown>{reason ?? "not recorded"}</Unknown>;
}

function Trials({ trials, warmups }: { trials: BenchmarkTrial[]; warmups: number }) {
  return (
    <Section
      id="trials"
      title="Trials"
      description={
        warmups > 0
          ? `Every trial in the order it ran (or will run). The first ${warmups === 1 ? "repetition" : `${warmups} repetitions`} of each arm and task is a warm-up, excluded from every result. Open a run for its plan, agents, trace and replay.`
          : "Every trial in the order it ran (or will run). Open a run for its plan, agents, trace and replay."
      }
    >
      {trials.length === 0 ? (
        <EmptyLine>This experiment has no trials.</EmptyLine>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[60rem] text-left text-xs" aria-label="Trials">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border/60">
                <th scope="col" className="py-2 pr-3 font-normal">#</th>
                <th scope="col" className="py-2 pr-3 font-normal">arm · task · rep</th>
                <th scope="col" className="py-2 pr-3 font-normal">status</th>
                <th scope="col" className="py-2 pr-3 font-normal">task success</th>
                <th scope="col" className="py-2 pr-3 font-normal">verification</th>
                <th scope="col" className="py-2 pr-3 font-normal">latency</th>
                <th scope="col" className="py-2 pr-3 font-normal">calls · retries (step/call)</th>
                <th scope="col" className="py-2 pr-3 font-normal">run timing</th>
                <th scope="col" className="py-2 pr-3 font-normal">notes</th>
                <th scope="col" className="py-2 font-normal">run</th>
              </tr>
            </thead>
            <tbody>
              {trials.map((trial) => (
                <TrialRow key={trial.trial_id} trial={trial} warmup={trial.repetition < warmups} warmups={warmups} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function TrialRow({ trial, warmup, warmups }: { trial: BenchmarkTrial; warmup: boolean; warmups: number }) {
  const status = TRIAL_STATUS[trial.status];
  const metrics = trial.metrics;
  const outcome = metrics ? OUTCOME[metrics.outcome] : null;
  const counted = metrics !== null && (metrics.outcome === "success" || metrics.outcome === "failure");
  return (
    <tr aria-label={`Trial ${trial.ordinal + 1}: ${trial.arm_id} on ${trial.task_id}`} className="border-b border-border/30 align-top">
      <td className="py-2 pr-3 font-mono">{trial.ordinal + 1}</td>
      <td className="py-2 pr-3 font-mono">
        {trial.arm_id} · {trial.task_id} · {warmup ? "warm-up" : trial.repetition - warmups + 1}
      </td>
      <td className="space-y-1 py-2 pr-3">
        <ToneBadge tone={status.tone} pulse={trial.status === "running"}>
          {status.label}
        </ToneBadge>
        {outcome && (
          <div>
            <ToneBadge tone={outcome.tone} pulse={false}>
              {outcome.label}
            </ToneBadge>
          </div>
        )}
      </td>
      <td className="py-2 pr-3">
        {!metrics ? (
          <Unknown>no result</Unknown>
        ) : (
          <Metric metrics={metrics} field="task_success">
            {metrics.task_success === null ? null : metrics.task_success ? "yes" : "no"}
          </Metric>
        )}
      </td>
      <td className="py-2 pr-3">
        {!metrics ? (
          <Unknown>no result</Unknown>
        ) : (
          <>
            <Metric metrics={metrics} field="verification_passed">
              {metrics.verification_passed === null
                ? null
                : metrics.verification_passed
                  ? "passed"
                  : metrics.verification_runs === 0
                    ? "did not run"
                    : "failed"}
            </Metric>
            {metrics.diagnostic_tests_passed !== null && (
              <div className="text-muted-foreground">
                diagnostic tests {metrics.diagnostic_tests_passed ? "passed" : "failed"} (not a verification)
              </div>
            )}
          </>
        )}
      </td>
      <td className="py-2 pr-3 font-mono">
        {!metrics ? (
          <Unknown>no result</Unknown>
        ) : (
          <Metric metrics={metrics} field="latency_ms">
            {metrics.latency_ms === null ? null : formatDuration(metrics.latency_ms)}
          </Metric>
        )}
      </td>
      <td className="py-2 pr-3 font-mono">
        {!metrics || !counted ? (
          <Unknown>{metrics ? "not counted" : "no result"}</Unknown>
        ) : (
          <>
            <Metric metrics={metrics} field="agent_calls">
              {metrics.agent_calls === null ? null : String(metrics.agent_calls)}
            </Metric>{" "}
            ·{" "}
            <Metric metrics={metrics} field="step_retries">
              {metrics.step_retries === null ? null : String(metrics.step_retries)}
            </Metric>
            /
            <Metric metrics={metrics} field="call_retries">
              {metrics.call_retries === null ? null : String(metrics.call_retries)}
            </Metric>
          </>
        )}
      </td>
      <td className="py-2 pr-3 font-mono">
        <TrialTimingCell metrics={metrics} warmup={warmup} />
      </td>
      <td className="max-w-64 py-2 pr-3 text-muted-foreground">
        {metrics?.outcome === "excluded" && (
          <p>
            <span className="text-foreground">excluded:</span> {metrics.excluded_reason ?? <Unknown>no reason recorded</Unknown>}
          </p>
        )}
        {trial.error && <p className="wrap-break-word">{trial.error}</p>}
      </td>
      <td className="py-2 font-mono">
        {trial.run_id ? (
          <Link className="text-primary hover:underline" to={`/runs/${encodeURIComponent(trial.run_id)}`}>
            {trial.run_id}
          </Link>
        ) : (
          <Unknown>no run</Unknown>
        )}
      </td>
    </tr>
  );
}

/** A trial's lifecycle from its run timings, or why it has none. */
function TrialTimingCell({ metrics, warmup }: { metrics: BenchmarkTrialMetrics | null; warmup: boolean }) {
  const state = trialTimingState(metrics, warmup);
  if (state.reason !== null) return <Unknown>{state.reason}</Unknown>;
  const timings = state.timings as NonNullable<typeof state.timings>;
  const lifecycle = formatTiming(timings.lifecycle_ms);
  return lifecycle === null ? (
    <Unknown>{timings.null_reasons.lifecycle_ms ?? "not recorded"}</Unknown>
  ) : (
    <>lifecycle {lifecycle}</>
  );
}

/**
 * Each measured trial's run timings, from its persisted span measurements.
 * Trials without timings are counted by reason instead of listed.
 */
function TrialTimings({ trials, warmups }: { trials: BenchmarkTrial[]; warmups: number }) {
  const finished = trials.filter((trial) => trial.metrics !== null);
  const states = finished.map((trial) => ({ trial, state: trialTimingState(trial.metrics, trial.repetition < warmups) }));
  const timed = states.filter(({ state }) => state.timings !== null && state.timings.measurement_status === "recorded");
  const without = new Map<string, number>();
  for (const { state } of states) {
    if (state.reason !== null) without.set(state.reason, (without.get(state.reason) ?? 0) + 1);
  }
  return (
    <Section
      id="trial-timings"
      title="Trial timings"
      description="Run timings of each measured trial, from its persisted span measurements. Busy and total figures are sums of possibly overlapping intervals, not elapsed time; trial slot wait was spent before the run started."
    >
      {finished.length === 0 ? (
        <EmptyLine>No trial has finished yet.</EmptyLine>
      ) : (
        <div className="space-y-2">
          {without.size > 0 && (
            <p className="text-xs text-muted-foreground">
              Without timings:{" "}
              {[...without.entries()].map(([reason, count]) => `${reason} (${count})`).join("; ")}.
            </p>
          )}
          {timed.length === 0 ? (
            <EmptyLine>No trial has recorded run timings.</EmptyLine>
          ) : (
            <ul className="space-y-2">
              {timed.map(({ trial, state }) => {
                const timings = state.timings as NonNullable<typeof state.timings>;
                const rep = trial.repetition - warmups + 1;
                return (
                  <li key={trial.trial_id}>
                    <details className="rounded-md border border-border/50 px-3 py-2">
                      <summary className="cursor-pointer text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                        <span className="font-mono">
                          #{trial.ordinal + 1} {trial.arm_id} · {trial.task_id} · {rep}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          · lifecycle {formatTiming(timings.lifecycle_ms) ?? "unknown"} · measurements v
                          {timings.measurements_version ?? "?"} ({measurementStatusText(timings.measurement_status)})
                        </span>
                      </summary>
                      <div className="mt-3">
                        <TrialTimingPanel timings={timings} />
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

/** Milliseconds between two recorded timestamps; null when either is missing or unreadable. */
function elapsedMs(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  return Number.isNaN(start) || Number.isNaN(end) || end < start ? null : end - start;
}
