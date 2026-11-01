import { ArrowUpRight, Pause, Play } from "lucide-react";
import { useEffect } from "react";
import { Link, useSearchParams } from "react-router";
import { isLiveStatus, useExecution, useRunHistory } from "@/api/queries";
import type { RunSummary } from "@/api/types";
import { AgentRoster } from "@/components/execution/AgentRoster";
import { ExecutionTimeline } from "@/components/execution/ExecutionTimeline";
import { formatClock, formatDate } from "@/components/execution/format";
import { RoleDot, Section, ToneBadge } from "@/components/execution/primitives";
import { RunOutcome } from "@/components/execution/RunPanels";
import { RunStatusBadge } from "@/components/run/RunStatusBadge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ExecutionView } from "@/components/visualization/ExecutionView";
import { activeInvocations, lifecycleRecorded, verificationRunsOf, type ExecutionState } from "@/domain/execution";
import { cn } from "@/lib/utils";
import { useViewStore } from "@/store/viewStore";

/** How often the console looks for new runs. */
const DISCOVER_RUNS_MS = 5_000;

/**
 * Live monitoring: pick a run (live ones first) and watch its execution
 * state change as events arrive. The selection is in the URL (?run=).
 */
export function ConsolePage() {
  const history = useRunHistory(15, { pollMs: DISCOVER_RUNS_MS });
  const runs = history.data?.pages[0]?.runs ?? [];
  const [params, setParams] = useSearchParams();
  const requested = params.get("run");
  const fallback = runs.find((run) => isLiveStatus(run.status)) ?? runs[0];
  const selectedId = requested ?? fallback?.run_id ?? null;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand-cyan">Live console</p>
        <h1 className="text-2xl font-semibold tracking-tight">Execution monitor</h1>
      </header>
      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside aria-label="Runs" className="glass h-fit rounded-xl p-3">
          <p className="mb-2 px-1 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Recent runs</p>
          {history.isPending && <Skeleton className="h-40" />}
          {history.isError && (
            <p role="alert" className="px-1 text-sm text-status-failed">
              {history.error.message}
            </p>
          )}
          {history.isSuccess && runs.length === 0 && (
            <p className="px-1 text-sm text-muted-foreground">
              No runs yet.{" "}
              <Link className="text-primary hover:underline" to="/runs/new">
                Start one
              </Link>
              .
            </p>
          )}
          <ul className="space-y-1">
            {[...runs]
              .sort((a, b) => Number(isLiveStatus(b.status)) - Number(isLiveStatus(a.status)))
              .map((run) => (
                <RunChoice
                  key={run.run_id}
                  run={run}
                  selected={run.run_id === selectedId}
                  onSelect={() => setParams({ run: run.run_id })}
                />
              ))}
          </ul>
        </aside>
        {selectedId ? <LiveRun key={selectedId} runId={selectedId} /> : !history.isPending && <EmptyConsole />}
      </div>
    </div>
  );
}

function RunChoice({ run, selected, onSelect }: { run: RunSummary; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "w-full rounded-lg px-2.5 py-2 text-left transition-colors",
          selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
        )}
      >
        <span className="flex items-center justify-between gap-2">
          <RunStatusBadge status={run.status} />
          <span className="font-mono text-[10px] text-muted-foreground">{formatDate(run.created_at)?.slice(11)}</span>
        </span>
        <span className="mt-1 block truncate text-xs">{run.goal}</span>
      </button>
    </li>
  );
}

function EmptyConsole() {
  return (
    <div className="glass rounded-xl p-8 text-center text-sm text-muted-foreground">
      Select a run to monitor, or{" "}
      <Link className="text-primary hover:underline" to="/runs/new">
        start a new one
      </Link>
      .
    </div>
  );
}

function LiveRun({ runId }: { runId: string }) {
  const { record, trace, execution, live } = useExecution(runId);
  const focusRun = useViewStore((state) => state.focusRun);
  const followLive = useViewStore((state) => state.followLive);
  const setFollowLive = useViewStore((state) => state.setFollowLive);
  useEffect(() => focusRun(runId), [focusRun, runId]);

  if (record.isPending) return <Skeleton className="h-96" aria-label="Loading run" />;
  if (record.isError) {
    return (
      <p role="alert" className="text-status-failed">
        Could not load run {runId}: {record.error.message}
      </p>
    );
  }
  const run = record.data.run;

  return (
    <div className="min-w-0 space-y-4">
      <div className="glass flex flex-wrap items-center gap-3 rounded-xl p-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{run.goal}</p>
          <p className="font-mono text-[11px] text-muted-foreground">{run.run_id}</p>
        </div>
        <ConnectionState live={live} fetching={trace.isFetching} error={trace.isError ? trace.error : null} finished={Boolean(execution?.outcome)} />
        <Button asChild variant="ghost" size="sm">
          <Link to={`/runs/${encodeURIComponent(run.run_id)}`}>
            Full run <ArrowUpRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
      {!execution ? (
        <Skeleton className="h-64" aria-label="Loading trace" />
      ) : (
        <>
          <RunOutcome state={execution} recordStatus={run.status} />
          <NowPanel state={execution} />
          <ExecutionView state={execution} live={live} />
          <AgentRoster state={execution} />
          <Counters state={execution} />
          <ExecutionTimeline
            events={execution.log}
            live={live}
            follow={live && followLive}
            maxHeight="28rem"
          />
          {live && (
            <Button variant="ghost" size="sm" onClick={() => setFollowLive(!followLive)} aria-pressed={followLive}>
              {followLive ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              {followLive ? "Pause following" : "Follow new events"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function ConnectionState({ live, fetching, error, finished }: { live: boolean; fetching: boolean; error: Error | null; finished: boolean }) {
  if (error) {
    return (
      <span role="status" className="text-xs text-status-failed">
        Connection problem ({error.message}); showing the last events received
      </span>
    );
  }
  if (live && !finished) {
    return (
      <ToneBadge tone="live">{fetching ? "receiving events" : "live · polling every second"}</ToneBadge>
    );
  }
  return <ToneBadge tone="muted">polling stopped: run finished</ToneBadge>;
}

/** What is actually executing right now: calls between start and result. */
function NowPanel({ state }: { state: ExecutionState }) {
  const calls = activeInvocations(state);
  const verifying = verificationRunsOf(state).filter((run) => run.status === "running");
  const recorded = lifecycleRecorded(state);
  return (
    <Section id="now" title="Now" description="Calls between their start and their result. Dispatched work is not shown as running.">
      {calls.length === 0 && verifying.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {state.outcome
            ? "Nothing is running: the run has finished."
            : !recorded && state.invocationOrder.length > 0
              ? "This trace has no lifecycle events, so in-flight work cannot be shown; calls appear as they finish."
              : "No agent or verification is running at this moment."}
        </p>
      ) : (
        <ul className="space-y-2" aria-label="Running now">
          {calls.map((call) => (
            <li key={call.id} className="flex flex-wrap items-center gap-2 rounded-md border border-status-live/25 bg-status-live/5 px-3 py-2 text-sm">
              <RoleDot role={call.role} />
              <span className="capitalize">{call.role}</span>
              {call.stepId && <span className="font-mono text-xs text-brand-cyan">{call.stepId}</span>}
              <span className="font-mono text-xs text-muted-foreground">
                attempt {call.attempt ?? "?"}
                {call.model && ` · ${call.model}`} · since {formatClock(call.startedAt) ?? "unknown"}
              </span>
              <ToneBadge tone="live" className="ml-auto">running</ToneBadge>
            </li>
          ))}
          {verifying.map((run) => (
            <li key={run.id} className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-agent-verifier/40 px-3 py-2 text-sm">
              <RoleDot role="verifier" />
              <span>{run.diagnostic ? "Diagnostic verification" : "Verification"}</span>
              <span className="font-mono text-xs text-muted-foreground">deterministic runner{run.command ? ` · ${run.command}` : ""}</span>
              <ToneBadge tone="live" className="ml-auto">running</ToneBadge>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Counters({ state }: { state: ExecutionState }) {
  const items = [
    ["Retries", state.retries.length],
    ["Revision rounds", state.dispatches.filter((d) => d.mode === "revision").length],
    ["Escalations", state.escalations.length],
    ["Failures", state.failures.length],
  ] as const;
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Run counters">
      {items.map(([label, value]) => (
        <div key={label} className="glass rounded-lg px-3 py-2">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className={cn("font-mono text-lg", value > 0 && label === "Failures" && "text-status-failed")}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
