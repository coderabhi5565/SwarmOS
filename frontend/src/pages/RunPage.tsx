import { Download, Square } from "lucide-react";
import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "@/api/client";
import { useCancelRun, useHealth, useExecution } from "@/api/queries";
import type { RunDetail, RunRecord } from "@/api/types";
import { AgentRoster } from "@/components/execution/AgentRoster";
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
import { ExecutionView } from "@/components/visualization/ExecutionView";
import { useViewStore } from "@/store/viewStore";

/** A run, rendered from its normalised execution state. Deep-linkable. */
export function RunPage() {
  const { runId } = useParams();
  const { record, trace, execution, live } = useExecution(runId);
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
      <RunHeader run={run} detail={record.data} live={live} />
      {trace.isError && (
        <p role="alert" className="rounded-lg border border-status-failed/30 bg-status-failed/5 px-3 py-2 text-sm text-status-failed">
          Could not refresh the trace: {trace.error.message}. Showing the last events received.
        </p>
      )}
      {!execution ? (
        <Skeleton className="h-64 w-full" aria-label="Loading trace" />
      ) : (
        <>
          <RunOutcome state={execution} recordStatus={run.status} />
          <ExecutionView state={execution} live={live} />
          <AgentRoster state={execution} />
          <PlanWaves state={execution} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <ExecutionTimeline events={execution.log} live={live} />
            <div className="space-y-4">
              <ReviewRounds state={execution} />
              <VerificationRuns state={execution} />
            </div>
          </div>
          <InvocationTable state={execution} />
          <div className="grid gap-4 lg:grid-cols-2">
            <UsagePanel state={execution} />
            <IssuesPanel state={execution} />
          </div>
        </>
      )}
    </div>
  );
}

function RunHeader({ run, detail, live }: { run: RunRecord; detail: RunDetail; live: boolean }) {
  const models = Object.entries(run.models_by_role);
  return (
    <header className="glass space-y-3 rounded-xl p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <RunStatusBadge status={run.status} />
        <span className="font-mono text-xs text-muted-foreground">{run.run_id}</span>
        <span className="font-mono text-xs text-muted-foreground">· {formatDate(run.created_at)}</span>
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

/** Only where the backend allows it: never in the public demo. */
function CancelRun({ runId }: { runId: string }) {
  const health = useHealth();
  const cancel = useCancelRun();
  if (health.data?.mode !== "local") return null;
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
