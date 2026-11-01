import { ArrowRight, Loader2 } from "lucide-react";
import { Link } from "react-router";
import { isLiveStatus, useRunHistory } from "@/api/queries";
import type { RunSummary } from "@/api/types";
import { formatDate, formatDuration } from "@/components/execution/format";
import { ToneBadge, Unknown } from "@/components/execution/primitives";
import { RunStatusBadge } from "@/components/run/RunStatusBadge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const PAGE_SIZE = 20;

/** Run history from the lightweight, cursor-paged run list. No traces are fetched here. */
export function HistoryPage() {
  const history = useRunHistory(PAGE_SIZE);
  const runs = history.data?.pages.flatMap((page) => page.runs) ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand-cyan">History</p>
          <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
          <p className="text-sm text-muted-foreground">Newest first. Open a run for its plan, agents and full trace.</p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/runs/new">New run</Link>
        </Button>
      </header>

      {history.isPending && (
        <div className="space-y-2" aria-busy="true" aria-label="Loading runs">
          {history.failureCount > 0 && (
            <p role="status" className="text-sm text-status-live">
              Waking the server… a free-tier backend can take up to a minute after a quiet period.
            </p>
          )}
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      )}

      {history.isError && (
        <p role="alert" className="text-status-failed">
          Could not load run history: {history.error.message}
        </p>
      )}

      {history.isSuccess && runs.length === 0 && (
        <div className="glass rounded-xl p-8 text-center">
          <p className="font-medium">No runs yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            <Link className="text-primary hover:underline" to="/runs/new">
              Start a run
            </Link>{" "}
            from the task catalog.
          </p>
        </div>
      )}

      {runs.length > 0 && (
        <ul className="glass divide-y divide-border/50 overflow-hidden rounded-xl" aria-label="Runs">
          {runs.map((run) => (
            <HistoryRow key={run.run_id} run={run} />
          ))}
        </ul>
      )}

      {history.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>
            {history.isFetchingNextPage && <Loader2 aria-hidden="true" className="animate-spin" />}
            {history.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
      {history.isFetchNextPageError && (
        <p role="alert" className="text-center text-sm text-status-failed">
          Could not load more runs: {history.error?.message}
        </p>
      )}
    </div>
  );
}

function HistoryRow({ run }: { run: RunSummary }) {
  const live = isLiveStatus(run.status);
  return (
    <li>
      <Link
        to={`/runs/${encodeURIComponent(run.run_id)}`}
        className="group grid gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-accent/30 md:grid-cols-[10rem_minmax(0,1fr)_auto]"
        aria-label={`Run ${run.run_id}: ${run.goal}`}
      >
        <div className="space-y-1">
          <RunStatusBadge status={run.status} />
          <p className="font-mono text-[11px] text-muted-foreground">{run.run_id}</p>
        </div>
        <div className="min-w-0 space-y-1">
          <p className="truncate text-sm">{run.goal}</p>
          <p className="flex flex-wrap gap-x-3 font-mono text-[11px] text-muted-foreground">
            <span>{formatDate(run.created_at)}</span>
            <span>{run.plan_step_count === null ? "no plan" : `${run.plan_step_count} step${run.plan_step_count === 1 ? "" : "s"}`}</span>
            <span>{run.agent_calls} call{run.agent_calls === 1 ? "" : "s"}</span>
            <span>{live ? "in progress" : (formatDuration(run.duration_ms) ?? "—")}</span>
            <span>{run.provider_kind}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <ReviewChip verdict={run.review_verdict} />
          <VerificationChip passed={run.verification_passed} diagnostic={run.verification_diagnostic} />
          <ArrowRight aria-hidden="true" className="hidden size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 md:block" />
        </div>
      </Link>
    </li>
  );
}

function ReviewChip({ verdict }: { verdict: RunSummary["review_verdict"] }) {
  if (verdict === "approve") return <ToneBadge tone="completed">review approved</ToneBadge>;
  if (verdict === "request_changes") return <ToneBadge tone="findings">changes requested</ToneBadge>;
  return (
    <span className="font-mono text-[11px]">
      <Unknown>not reviewed</Unknown>
    </span>
  );
}

function VerificationChip({ passed, diagnostic }: { passed: boolean | null; diagnostic: boolean | null }) {
  if (passed === null) {
    return (
      <span className="font-mono text-[11px]">
        <Unknown>not verified</Unknown>
      </span>
    );
  }
  const label = `${diagnostic ? "diagnostic " : ""}tests ${passed ? "passed" : "failed"}`;
  return <ToneBadge tone={passed ? "completed" : "failed"}>{label}</ToneBadge>;
}
