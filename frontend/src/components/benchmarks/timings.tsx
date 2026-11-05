import type {
  BenchmarkTimingAggregate,
  BenchmarkTimingSummary,
  BenchmarkTrialMetrics,
  BenchmarkTrialTimings,
} from "@/api/types";
import { humanize } from "@/components/execution/format";
import { EmptyLine, Unknown } from "@/components/execution/primitives";

/**
 * Run timings from persisted span measurements (metrics v2), as the backend
 * reports them. Nothing is computed here: no figure is derived from another,
 * and no interval is added to another. A value the backend does not
 * establish is shown as unknown with its reason, never as zero.
 */

/** Milliseconds, finer than formatDuration below 10 ms (sub-millisecond spans are common). */
export function formatTiming(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

/** What a figure is: one interval, a union, a sum of possibly overlapping intervals, or a count. */
export type TimingKind = "elapsed" | "busy" | "total" | "count";

export type TimingField = Exclude<keyof BenchmarkTrialTimings, "measurement_status" | "measurements_version" | "null_reasons">;

export interface TimingRow {
  field: TimingField;
  label: string;
  kind: TimingKind;
}

export const KIND_NOTE: Record<TimingKind, string> = {
  elapsed: "elapsed",
  busy: "busy: a sum, overlaps counted",
  total: "total time spent, not elapsed",
  count: "count",
};

/** Every trial timing field, in reading order. */
export const TIMING_GROUPS: { title: string; rows: TimingRow[] }[] = [
  {
    title: "Run phases",
    rows: [
      { field: "lifecycle_ms", label: "lifecycle (queued to terminal)", kind: "elapsed" },
      { field: "admission_ms", label: "admission", kind: "elapsed" },
      { field: "execution_ms", label: "execution", kind: "elapsed" },
      { field: "setup_ms", label: "setup", kind: "elapsed" },
      { field: "graph_ms", label: "graph", kind: "elapsed" },
      { field: "finalization_ms", label: "finalization", kind: "elapsed" },
    ],
  },
  {
    title: "Agents",
    rows: [
      { field: "planner_ms", label: "planner", kind: "total" },
      { field: "reviewer_ms", label: "reviewer", kind: "total" },
      { field: "coder_busy_ms", label: "coder busy", kind: "busy" },
      { field: "coder_wall_ms", label: "coder wall (union)", kind: "elapsed" },
      { field: "coder_critical_path_ms", label: "coder critical path", kind: "elapsed" },
    ],
  },
  {
    title: "Provider calls",
    rows: [
      { field: "provider_calls", label: "calls", kind: "count" },
      { field: "provider_call_busy_ms", label: "call busy", kind: "busy" },
      { field: "provider_call_wall_ms", label: "call wall (union)", kind: "elapsed" },
      { field: "http_attempts", label: "HTTP attempts", kind: "count" },
      { field: "http_attempt_busy_ms", label: "HTTP attempt busy", kind: "busy" },
      { field: "http_attempt_wall_ms", label: "HTTP attempt wall (union)", kind: "elapsed" },
      { field: "parse_total_ms", label: "response parsing", kind: "total" },
      { field: "backoff_total_ms", label: "retry backoff", kind: "total" },
    ],
  },
  {
    title: "Verification and orchestration",
    rows: [
      { field: "verification_ms", label: "verification (gating)", kind: "total" },
      { field: "diagnostic_verification_ms", label: "diagnostic verification", kind: "total" },
      { field: "graph_gap_ms", label: "graph gap", kind: "total" },
      { field: "critical_orchestration_ms", label: "critical orchestration", kind: "total" },
      { field: "parallel_orchestration_ms", label: "parallel orchestration", kind: "total" },
    ],
  },
  {
    title: "Waits",
    rows: [
      { field: "schedule_delay_total_ms", label: "step schedule delay", kind: "total" },
      { field: "slot_wait_total_ms", label: "coding slot wait", kind: "total" },
      { field: "ledger_wait_total_ms", label: "budget ledger wait", kind: "total" },
      { field: "trial_slot_wait_ms", label: "trial slot wait (before the run)", kind: "elapsed" },
    ],
  },
];

/** Why a run has no usable measurements, in words. */
const STATUS_TEXT: Record<string, string> = {
  recorded: "recorded",
  run_in_progress: "run still in progress",
  predates_measurements: "run predates measurements",
  process_crash: "server stopped during the run",
  measurement_flush_failed: "measurements could not be saved",
  instrumentation_disabled: "recording was off",
  not_recorded: "not recorded",
  unreadable: "stored measurements unreadable",
  unsupported_version: "unsupported measurement version",
  metrics_v1: "recorded before trial timings",
};

export function measurementStatusText(status: string): string {
  return STATUS_TEXT[status] ?? humanize(status);
}

export function formatTimingValue(kind: TimingKind, value: number | null): string | null {
  if (value === null) return null;
  return kind === "count" ? String(value) : formatTiming(value);
}

const reasonList = (reasons: Record<string, number>) =>
  Object.entries(reasons)
    .map(([reason, count]) => `${reason} (${count})`)
    .join("; ");

/**
 * An aggregate's timing distributions: per metric, n trials established it,
 * missing did not (with reasons); median, nearest-rank P95, min and max.
 * Only counted trials with recorded measurements are measured; the others
 * are listed as unavailable and enter no figure.
 */
export function TimingAggregateTable({ timings, counted }: { timings: BenchmarkTimingAggregate; counted: number }) {
  const unavailable = Object.entries(timings.unavailable);
  const unavailableTotal = unavailable.reduce((sum, [, count]) => sum + count, 0);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        <span className="text-foreground">
          {timings.measured} of {counted} counted trial{counted === 1 ? "" : "s"}
        </span>{" "}
        have recorded run measurements.
        {unavailableTotal > 0 && (
          <>
            {" "}
            The other {unavailableTotal} are left out of every timing figure:{" "}
            {unavailable.map(([status, count]) => `${measurementStatusText(status)} (${count})`).join("; ")}.
          </>
        )}
      </p>
      {timings.measured === 0 ? (
        <EmptyLine>No timing figures: no counted trial has recorded run measurements.</EmptyLine>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-xs">
            <caption className="sr-only">Timing distributions over {timings.measured} measured trials</caption>
            <thead className="text-muted-foreground">
              <tr className="border-b border-border/60">
                <th scope="col" className="py-1.5 pr-3 font-normal">metric</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">n</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">missing</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">median</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">
                  <abbr title="nearest-rank 95th percentile: an observed value">p95</abbr>
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">min</th>
                <th scope="col" className="py-1.5 text-right font-normal">max</th>
              </tr>
            </thead>
            {TIMING_GROUPS.map((group) => (
              <tbody key={group.title}>
                <tr>
                  <th scope="rowgroup" colSpan={7} className="pt-3 pb-1 text-left text-[11px] font-medium text-foreground">
                    {group.title}
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <AggregateTimingRow key={row.field} row={row} summary={timings.metrics[row.field]} />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </div>
  );
}

function AggregateTimingRow({
  row,
  summary,
}: {
  row: TimingRow;
  summary: BenchmarkTimingSummary | undefined;
}) {
  const cell = (value: number | null) => {
    const text = formatTimingValue(row.kind, value);
    return text === null ? <Unknown>—</Unknown> : text;
  };
  return (
    <tr className="border-b border-border/30 align-top">
      <th scope="row" className="py-1.5 pr-3 font-normal">
        {row.label} <span className="text-muted-foreground">· {KIND_NOTE[row.kind]}</span>
        {summary && summary.missing > 0 && (
          <div className="text-[11px] text-muted-foreground">missing: {reasonList(summary.missing_reasons)}</div>
        )}
      </th>
      {summary === undefined ? (
        <td colSpan={6} className="py-1.5 text-right">
          <Unknown>not reported</Unknown>
        </td>
      ) : (
        <>
          <td className="py-1.5 pr-3 text-right font-mono">{summary.n}</td>
          <td className="py-1.5 pr-3 text-right font-mono">{summary.missing}</td>
          <td className="py-1.5 pr-3 text-right font-mono">{cell(summary.median)}</td>
          <td className="py-1.5 pr-3 text-right font-mono">{cell(summary.p95)}</td>
          <td className="py-1.5 pr-3 text-right font-mono">{cell(summary.min)}</td>
          <td className="py-1.5 text-right font-mono">{cell(summary.max)}</td>
        </>
      )}
    </tr>
  );
}

/**
 * Whether a trial has run timings, and if not, why: a warm-up, an excluded
 * or unfinished trial, one recorded before trial timings, or a run whose
 * measurements are unavailable (with the backend's status).
 */
export function trialTimingState(
  metrics: BenchmarkTrialMetrics | null,
  warmup: boolean,
): { timings: BenchmarkTrialTimings | null; reason: string | null } {
  if (warmup) return { timings: null, reason: "warm-up: not measured" };
  if (metrics === null) return { timings: null, reason: "no result" };
  if (metrics.outcome === "excluded") {
    return { timings: null, reason: `excluded${metrics.excluded_reason ? ` (${metrics.excluded_reason})` : ""}: not measured` };
  }
  if (metrics.outcome === "incomplete") return { timings: null, reason: "run not finished" };
  const timings = metrics.timings;
  if (timings === null) return { timings: null, reason: measurementStatusText("metrics_v1") };
  if (timings.measurement_status !== "recorded") {
    return { timings, reason: `no run measurements: ${measurementStatusText(timings.measurement_status)}` };
  }
  return { timings, reason: null };
}

/** One trial's timings by group; an unknown carries the backend's reason. */
export function TrialTimingPanel({ timings }: { timings: BenchmarkTrialTimings }) {
  return (
    <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
      {TIMING_GROUPS.map((group) => (
        <section key={group.title} aria-label={group.title} className="min-w-0">
          <h4 className="mb-1 text-[11px] font-medium text-foreground">{group.title}</h4>
          <dl className="space-y-1 text-xs">
            {group.rows.map((row) => {
              const text = formatTimingValue(row.kind, timings[row.field]);
              const reason = timings.null_reasons[row.field] ?? timings.null_reasons["*"] ?? "not recorded";
              return (
                <div key={row.field} className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <dt className="text-muted-foreground">
                    {row.label} <span className="text-[10px]">· {KIND_NOTE[row.kind]}</span>
                  </dt>
                  <dd className="font-mono">{text === null ? <Unknown>{reason}</Unknown> : text}</dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </div>
  );
}
