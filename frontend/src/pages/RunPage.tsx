import { Download, Square } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "@/api/client";
import { useMe } from "@/api/auth";
import { useCancelRun, useHealth, useExecution } from "@/api/queries";
import type { RunDetail, RunRecord } from "@/api/types";
import { AgentRoster } from "@/components/execution/AgentRoster";
import { ConnectionBadge } from "@/components/execution/ConnectionBadge";
import { ExecutionTimeline } from "@/components/execution/ExecutionTimeline";
import { formatDate } from "@/components/execution/format";
import { InvocationTable } from "@/components/execution/InvocationTable";
import { PlanWaves } from "@/components/execution/PlanWaves";
import { ReviewRounds, VerificationRuns } from "@/components/execution/ReviewAndVerification";
import { IssuesPanel, RunOutcome, UsagePanel } from "@/components/execution/RunPanels";
import { RoleDot, Unknown } from "@/components/execution/primitives";
import { RunStatusBadge } from "@/components/run/RunStatusBadge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PlaybackControls } from "@/components/playback/PlaybackControls";
import { usePlayback } from "@/components/playback/usePlayback";
import { ExecutionView } from "@/components/visualization/ExecutionView";
import { useViewStore } from "@/store/viewStore";

/** A run, rendered from its normalised execution state. Deep-linkable. */
export function RunPage() {
  const { runId } = useParams();
  const { record, trace, execution, live, connection } = useExecution(runId);
  // A replay position, if one is chosen, is drawn by every progress panel;
  // the run's own state keeps updating underneath and is never replaced.
  const playback = usePlayback(execution);
  const shown = playback.displayed;
  // The graph's selection belongs to this run; another run starts unselected.
  const focusRun = useViewStore((state) => state.focusRun);
  useEffect(() => {
    if (runId) focusRun(runId);
  }, [focusRun, runId]);

  if (record.isPending) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading run">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (record.isError) {
    if (record.error instanceof ApiError && record.error.status === 404) {
      return (
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">Run not found</h1>
          <p className="text-muted-foreground">
            No run <code>{runId}</code>.{" "}
            <Link className="text-primary hover:underline" to="/history">
              Browse run history
            </Link>
          </p>
        </div>
      );
    }
    return (
      <p role="alert" className="text-status-failed">
        Could not load this run: {record.error.message}
      </p>
    );
  }

  const run = record.data.run;
  return (
    <div className="space-y-4">
      <RunHeader
        run={run}
        detail={record.data}
        live={live}
        // Trace errors have their own alert below.
        connection={<ConnectionBadge connection={connection} live={live} error={null} />}
      />
      {trace.isError && (
        <p role="alert" className="rounded-lg border border-status-failed/30 bg-status-failed/5 px-3 py-2 text-sm text-status-failed">
          Could not refresh the trace: {trace.error.message}. Showing the last events received.
        </p>
      )}
      {!execution || !shown ? (
        <Skeleton className="h-64 w-full" aria-label="Loading trace" />
      ) : (
        <>
          <RunOutcome state={execution} recordStatus={run.status} />
          <PlaybackControls execution={execution} view={playback} live={live} />
          <ExecutionView state={shown} live={live && !playback.replaying} replaying={playback.replaying} />
          <AgentRoster state={shown} />
          <PlanWaves state={shown} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <ExecutionTimeline events={shown.log} live={live && !playback.replaying} />
            <div className="space-y-4">
              <ReviewRounds state={shown} />
              <VerificationRuns state={shown} />
            </div>
          </div>
          <InvocationTable state={shown} />
          <div className="grid gap-4 lg:grid-cols-2">
            <UsagePanel state={shown} />
            <IssuesPanel state={shown} />
          </div>
        </>
      )}
    </div>
  );
}

function RunHeader({
  run,
  detail,
  live,
  connection,
}: {
  run: RunRecord;
  detail: RunDetail;
  live: boolean;
  connection: ReactNode;
}) {
  const models = Object.entries(run.models_by_role);
  return (
    <header className="glass space-y-3 rounded-xl p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <RunStatusBadge status={run.status} />
        <span className="font-mono text-xs text-muted-foreground">{run.run_id}</span>
        <span className="font-mono text-xs text-muted-foreground">· {formatDate(run.created_at)}</span>
        {live && connection}
        <div className="ml-auto flex items-center gap-2">
          {live && <CancelRun runId={run.run_id} />}
          <Button variant="ghost" size="sm" onClick={() => downloadTrace(detail)}>
            <Download aria-hidden="true" />
            Download trace
          </Button>
        </div>
      </div>
      <h1 className="text-lg font-semibold leading-snug sm:text-xl">{run.goal}</h1>
      <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Provider</dt>
          <dd className="font-mono">
            {run.provider} <span className="text-muted-foreground">({run.provider_kind})</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Policy</dt>
          <dd className="font-mono">{run.model_policy}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Models</dt>
          <dd className="flex flex-wrap gap-x-3 font-mono">
            {models.length === 0 ? (
              <Unknown />
            ) : (
              models.map(([role, model]) => (
                <span key={role} className="inline-flex items-center gap-1.5">
                  {isActor(role) && <RoleDot role={role} />}
                  {role} → {model}
                </span>
              ))
            )}
          </dd>
        </div>
      </dl>
      {run.provider_warning && <p className="text-xs text-status-findings">{run.provider_warning}</p>}
    </header>
  );
}

const isActor = (role: string): role is "planner" | "coder" | "reviewer" | "verifier" =>
  role === "planner" || role === "coder" || role === "reviewer" || role === "verifier";

/**
 * Only where the backend may allow it: locally, or for a signed-in account
 * in the public demo (a user may cancel their own runs; the server says so
 * if this run is someone else's).
 */
function CancelRun({ runId }: { runId: string }) {
  const health = useHealth();
  const me = useMe();
  const cancel = useCancelRun();
  if (health.data?.mode !== "local" && !(health.data?.mode === "public_demo" && me.signedIn)) return null;
  return (
    <>
      <Button variant="outline" size="sm" disabled={cancel.isPending || cancel.isSuccess} onClick={() => cancel.mutate(runId)}>
        <Square aria-hidden="true" />
        {cancel.isPending || cancel.isSuccess ? "Cancelling…" : "Cancel run"}
      </Button>
      {cancel.isError && (
        <span role="alert" className="text-xs text-status-failed">
          {cancel.error.message}
        </span>
      )}
    </>
  );
}

function downloadTrace(detail: RunDetail) {
  const blob = new Blob([JSON.stringify(detail, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${detail.run.run_id}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
