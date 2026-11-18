import { cn } from "@/lib/utils";
import type { PhaseId } from "./simulation";

/** The pipeline in four words, one per phase of the hero's execution cycle. */
export const TICKER: { phase: PhaseId; label: string }[] = [
  { phase: "plan", label: "PLANNER" },
  { phase: "fan-out", label: "3× CODER WAVE" },
  { phase: "evidence-guard", label: "EVIDENCE GUARD" },
  { phase: "verify", label: "PYTEST" },
];

/**
 * The pipeline as a monospace ticker. With the 3D scene running, the stage
 * the scene is playing lights up (`phase` comes from the scene). With the 2D
 * fallback there is no cycle to follow, so `phase` is null and it reads as a
 * plain label: nothing lights and nothing moves.
 */
export function PhaseTicker({ phase, className }: { phase: PhaseId | null; className?: string }) {
  return (
    <ol
      aria-label="Pipeline"
      className={cn(
        "inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-full border border-border/70 bg-background/50 px-3 py-1.5 font-mono text-[11px] backdrop-blur-sm",
        className,
      )}
    >
      {TICKER.map((item, index) => {
        const active = item.phase === phase;
        return (
          <li key={item.phase} className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
            {index > 0 && (
              <span aria-hidden="true" className="text-muted-foreground/60">
                →
              </span>
            )}
            <span
              className={cn(
                "rounded-sm px-1 transition-colors duration-300",
                active ? "bg-brand-cyan/15 text-brand-cyan shadow-[0_0_14px_-2px_var(--brand-cyan)]" : "text-muted-foreground",
              )}
            >
              {item.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
