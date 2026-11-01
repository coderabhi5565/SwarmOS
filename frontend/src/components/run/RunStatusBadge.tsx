import type { RunStatus } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABEL, STATUS_TONE, type StatusTone } from "@/domain/status";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<StatusTone, string> = {
  live: "border-status-live/35 bg-status-live/10 text-status-live",
  completed: "border-status-completed/35 bg-status-completed/10 text-status-completed",
  findings: "border-status-findings/35 bg-status-findings/10 text-status-findings",
  invalid: "border-status-invalid/35 bg-status-invalid/10 text-status-invalid",
  failed: "border-status-failed/40 bg-status-failed/10 text-status-failed",
  cancelled: "border-status-cancelled/35 bg-transparent text-status-cancelled",
};

export function RunStatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  const tone = STATUS_TONE[status];
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-mono", TONE_CLASS[tone], className)}>
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full bg-current", tone === "live" && "animate-pulse")}
      />
      {STATUS_LABEL[status]}
    </Badge>
  );
}
