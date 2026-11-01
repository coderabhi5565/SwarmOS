import type { RunStatus } from "../types";

const LABELS: Record<RunStatus, string> = {
  queued: "queued",
  running: "running",
  completed: "completed",
  completed_with_findings: "needs review",
  review_invalid: "invalid review",
  failed: "failed",
  cancelled: "cancelled",
  budget_exceeded: "budget exceeded",
  limit_exceeded: "limit exceeded",
  timed_out: "timed out",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`badge status-${status}`}>
      <span className="dot" aria-hidden="true" />
      {LABELS[status] ?? status}
    </span>
  );
}