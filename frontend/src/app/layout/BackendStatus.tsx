import { useHealth } from "@/api/queries";
import { cn } from "@/lib/utils";

/**
 * Live backend status from GET /health. A free-tier backend sleeps when idle,
 * so the first requests can fail for a while: that is shown as "waking"
 * (still retrying), not as a failure, until the retries are exhausted.
 */
export function BackendStatus({ className }: { className?: string }) {
  const health = useHealth();

  const state = health.isSuccess
    ? "online"
    : health.isError
      ? "offline"
      : health.failureCount > 0
        ? "waking"
        : "checking";

  const label = {
    online: health.data ? `${health.data.mode === "public_demo" ? "public demo" : "local"} · ${health.data.provider_kind}` : "online",
    offline: "API unreachable",
    waking: "waking server…",
    checking: "connecting…",
  }[state];

  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-xs",
        state === "online" && "border-status-completed/30 text-status-completed",
        state === "offline" && "border-status-failed/40 text-status-failed",
        (state === "waking" || state === "checking") && "border-status-live/30 text-status-live",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full bg-current",
          (state === "waking" || state === "checking") && "animate-pulse",
        )}
      />
      {label}
    </span>
  );
}
