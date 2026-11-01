import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Tone = "live" | "completed" | "findings" | "invalid" | "failed" | "cancelled" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  live: "border-status-live/35 bg-status-live/10 text-status-live",
  completed: "border-status-completed/35 bg-status-completed/10 text-status-completed",
  findings: "border-status-findings/35 bg-status-findings/10 text-status-findings",
  invalid: "border-status-invalid/35 bg-status-invalid/10 text-status-invalid",
  failed: "border-status-failed/40 bg-status-failed/10 text-status-failed",
  cancelled: "border-status-cancelled/35 bg-transparent text-status-cancelled",
  muted: "border-border bg-transparent text-muted-foreground",
};

/** A small status pill. "live" pulses (static under reduced motion). */
export function ToneBadge({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] leading-4",
        TONE_CLASS[tone],
        className,
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full bg-current", tone === "live" && "animate-pulse")} />
      {children}
    </span>
  );
}

export type ActorRole = "planner" | "coder" | "reviewer" | "verifier";

const ROLE_DOT: Record<ActorRole, string> = {
  planner: "bg-agent-planner",
  coder: "bg-agent-coder",
  reviewer: "bg-agent-reviewer",
  verifier: "bg-agent-verifier",
};

export function RoleDot({ role, className }: { role: ActorRole; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full", ROLE_DOT[role], className)} />;
}

/** The value the trace does not establish. Always explicit, never zero. */
export function Unknown({ children = "not recorded" }: { children?: ReactNode }) {
  return <span className="text-muted-foreground/70 italic">{children}</span>;
}

/** A value, or an explicit unknown. */
export function Value({ value, missing }: { value: ReactNode | null | undefined; missing?: ReactNode }) {
  return value === null || value === undefined || value === "" ? <Unknown>{missing}</Unknown> : <>{value}</>;
}

export function Section({
  title,
  description,
  action,
  children,
  className,
  id,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const headingId = id ? `${id}-heading` : undefined;
  return (
    <section aria-labelledby={headingId} id={id} className={cn("glass rounded-xl p-4 sm:p-5", className)}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id={headingId} className="text-sm font-semibold tracking-wide text-foreground">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
