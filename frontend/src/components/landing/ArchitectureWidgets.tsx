import { Check, ShieldX } from "lucide-react";
import { AnimatePresence, useReducedMotionConfig } from "motion/react";
import * as m from "motion/react-m";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The small diagrams inside the landing page's architecture cards. Each is a
 * schematic of how SwarmOS behaves, drawn with the code's own names; none is
 * a measurement, and each says so where a reader could take it for one.
 * Loops stop under reduced motion, which shows the finished state instead.
 */

const LOOP = { duration: 2.4, repeat: Infinity, repeatDelay: 1.2, ease: "easeInOut" } as const;

// ----------------------------------------------------------------------
const LANES = ["inspect_tests", "draft_implementation", "document_change"];

function Lanes({ title, starts, reduced }: { title: string; starts: number[]; reduced: boolean }) {
  return (
    <div role="group" aria-label={title} className="space-y-1">
      <p className="font-mono text-[10px] text-muted-foreground">{title}</p>
      {LANES.map((lane, index) => (
        <div key={lane} className="relative h-3.5 overflow-hidden rounded-sm bg-border/40">
          <m.div
            data-lane={lane}
            className="absolute inset-y-0 w-1/3 origin-left rounded-sm bg-agent-coder/80"
            style={{ left: `${starts[index] * 100}%` }}
            initial={reduced ? false : { scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={reduced ? { duration: 0 } : { ...LOOP, duration: 0.8, delay: starts[index] * 2.4 }}
          />
        </div>
      ))}
    </div>
  );
}

/** Three code_step lanes: started together in a wave, or queued one after another. */
export function WaveGantt() {
  const reduced = useReducedMotionConfig() ?? false;
  return (
    <figure aria-label="Parallel and sequential scheduling of three coding steps" className="space-y-2">
      <Lanes title="parallel wave · code_step × 3" starts={[0, 0, 0]} reduced={reduced} />
      <Lanes title="sequential · one at a time" starts={[0, 1 / 3, 2 / 3]} reduced={reduced} />
      <figcaption className="text-[10px] text-muted-foreground">Schedule shape, not a measurement.</figcaption>
    </figure>
  );
}

// ----------------------------------------------------------------------
type Finding = "uncited" | "cited";

const FINDINGS: Record<Finding, { label: string; lines: string[]; outcome: string; ok: boolean; note: string }> = {
  uncited: {
    label: "Blocker, no evidence",
    lines: ['severity: "blocker"', 'claim: "normalize_tags is wrong"', "file: —   line: —   test output: —"],
    outcome: "review_invalid",
    ok: false,
    note: "Rejected by the guard. The run ends; it is never an approval.",
  },
  cited: {
    label: "Blocker, file + line cited",
    lines: ['severity: "blocker"', 'file: "target.py"   line: 12', 'test output: "AssertionError: tags not lowercased"'],
    outcome: "request_changes",
    ok: true,
    note: "Evidence exists, so the verdict stands and a revision is dispatched.",
  },
};

/** Choose a reviewer finding and see what the evidence guard does with it. */
export function EvidenceGuardDemo() {
  const [finding, setFinding] = useState<Finding>("uncited");
  const current = FINDINGS[finding];
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="Reviewer finding" className="inline-flex rounded-md border border-border/70 p-0.5 text-[11px]">
        {(Object.keys(FINDINGS) as Finding[]).map((key) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={finding === key}
            onClick={() => setFinding(key)}
            className={cn(
              "rounded px-2 py-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              finding === key ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {FINDINGS[key].label}
          </button>
        ))}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <m.div
          key={finding}
          role="status"
          aria-label="Guard outcome"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18 }}
          className="rounded-md border border-border/60 bg-background/60 p-2 font-mono text-[10px]"
        >
          {current.lines.map((line) => (
            <p key={line} className="text-muted-foreground">
              {line}
            </p>
          ))}
          <p className={cn("mt-1.5 flex items-center gap-1.5 font-medium", current.ok ? "text-status-completed" : "text-status-invalid")}>
            {current.ok ? <Check aria-hidden="true" className="size-3" /> : <ShieldX aria-hidden="true" className="size-3" />}
            guard → {current.outcome}
          </p>
          <p className="mt-0.5 font-sans text-muted-foreground">{current.note}</p>
        </m.div>
      </AnimatePresence>
      <p className="text-[10px] text-muted-foreground">Example findings, not from a recorded run.</p>
    </div>
  );
}

// ----------------------------------------------------------------------
/** Span rows as offsets and widths in percent of the lifecycle (a schematic). */
const SPANS: { name: string; left: number; width: number; depth: number }[] = [
  { name: "lifecycle", left: 0, width: 100, depth: 0 },
  { name: "admission", left: 0, width: 8, depth: 1 },
  { name: "setup", left: 8, width: 12, depth: 1 },
  { name: "graph", left: 20, width: 74, depth: 1 },
  { name: "verify.process", left: 52, width: 40, depth: 2 },
  { name: "finalization", left: 94, width: 6, depth: 1 },
];

/** A run's spans as a waterfall: each an interval on one monotonic clock. */
export function SpanWaterfall() {
  const reduced = useReducedMotionConfig() ?? false;
  return (
    <figure aria-label="A run's timing spans as a waterfall" className="space-y-1">
      {SPANS.map((span, index) => (
        <div key={span.name} className="grid grid-cols-[6.5rem_1fr] items-center gap-2">
          <span className="truncate font-mono text-[10px] text-muted-foreground" style={{ paddingLeft: span.depth * 8 }}>
            {span.name}
          </span>
          <div className="relative h-3 rounded-sm bg-border/40">
            <m.div
              data-span={span.name}
              className={cn("absolute inset-y-0 origin-left rounded-sm", span.depth === 0 ? "bg-foreground/30" : "bg-brand-cyan/70")}
              style={{ left: `${span.left}%`, width: `${span.width}%` }}
              initial={reduced ? false : { scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={reduced ? { duration: 0 } : { ...LOOP, duration: 0.5, delay: index * 0.22 }}
            />
          </div>
        </div>
      ))}
      <figcaption className="pt-1 text-[10px] text-muted-foreground">
        Offsets on <span className="font-mono">perf_counter_ns</span>. Not to scale.
      </figcaption>
    </figure>
  );
}

// ----------------------------------------------------------------------
const CHECKS = [
  "ast policy: imports allowlisted",
  "socket: refused",
  "process creation: refused",
  "write outside workspace: refused",
  "pytest: isolated mode (-I)",
];

/** The public demo's checks, ticked off in the order a run meets them. */
export function SandboxChecks() {
  const reduced = useReducedMotionConfig() ?? false;
  const [done, setDone] = useState(reduced ? CHECKS.length : 0);

  useEffect(() => {
    if (reduced) {
      setDone(CHECKS.length);
      return;
    }
    // One more check every 600 ms; hold the full list, then start over.
    const id = window.setInterval(() => setDone((count) => (count >= CHECKS.length + 3 ? 0 : count + 1)), 600);
    return () => window.clearInterval(id);
  }, [reduced]);

  return (
    <ul aria-label="Public sandbox checks" className="space-y-1 font-mono text-[10px]">
      {CHECKS.map((check, index) => {
        const passed = index < done;
        return (
          <li key={check} data-passed={passed} className={cn("flex items-center gap-2 transition-colors duration-300", passed ? "text-foreground" : "text-muted-foreground/50")}>
            <span
              aria-hidden="true"
              className={cn(
                "grid size-3.5 place-items-center rounded-sm border transition-colors duration-300",
                passed ? "border-status-completed/60 bg-status-completed/15 text-status-completed" : "border-border/60",
              )}
            >
              {passed && <Check className="size-2.5" />}
            </span>
            {check}
          </li>
        );
      })}
    </ul>
  );
}
