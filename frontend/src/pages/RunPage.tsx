import { Link, useParams } from "react-router";
import { ApiError } from "@/api/client";
import { isLiveStatus, useRun, useRunEvents } from "@/api/queries";
import { RunDetail as LegacyRunDetail } from "@/components/RunDetail";
import { Skeleton } from "@/components/ui/skeleton";
import type { RunDetail as LegacyRunDetailData } from "@/types";
import { ErrorLine } from "./OverviewPage";

/**
 * A deep-linkable run. Data comes from the new query layer (the record polled
 * while live, events fetched incrementally by cursor); the panels are still
 * the pre-redesign RunDetail until M3.3 replaces them.
 */
export function RunPage() {
  const { runId } = useParams();
  const run = useRun(runId);
  const live = isLiveStatus(run.data?.run.status);
  const events = useRunEvents(runId, { live });

  if (run.isPending) {
    return <Skeleton className="h-64 w-full" aria-label="Loading run" />;
  }
  if (run.isError) {
    if (run.error instanceof ApiError && run.error.status === 404) {
      return (
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">Run not found</h1>
          <p className="text-muted-foreground">
            No run <code>{runId}</code>. <Link className="text-primary hover:underline" to="/">Back to overview</Link>
          </p>
        </div>
      );
    }
    return <ErrorLine error={run.error} />;
  }

  const detail = {
    run: run.data.run,
    // Prefer the incrementally polled trace; fall back to the record's copy.
    events: events.data?.events ?? run.data.events,
  } as LegacyRunDetailData;

  return (
    <div className="legacy-ui">
      <LegacyRunDetail detail={detail} />
    </div>
  );
}
