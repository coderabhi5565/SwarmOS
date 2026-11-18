import { useReducedMotionConfig } from "motion/react";
import * as m from "motion/react-m";
import { cn } from "@/lib/utils";
import type { WalkthroughStep } from "./traceWalkthrough";

const WIDTH = 720;
const HEIGHT = 104;
const BOX = { width: 150, height: 68 };

/** The event kinds a step's recorded excerpts show, in order, once each. */
export function stepKinds(step: WalkthroughStep): string[] {
  return [...new Set(step.events.map((event) => event.kind))];
}

/**
 * The walkthrough's stages as a row of boxes joined by beams. One highlight
 * slides, on a spring, to the stage in view; the beam into that stage draws
 * itself, carries moving dashes and a travelling pulse; beams already
 * crossed stay lit. Under reduced motion the highlight and beams are simply
 * in place. Each box names the event kinds its recorded excerpts show. A
 * picture of the tabs below it, so it is hidden from assistive technology:
 * the tabs carry the meaning.
 */
export function BeamDiagram({ steps, activeIndex }: { steps: WalkthroughStep[]; activeIndex: number }) {
  const reduced = useReducedMotionConfig() ?? false;
  const gap = (WIDTH - steps.length * BOX.width) / (steps.length - 1);
  const x = (index: number) => index * (BOX.width + gap);
  const y = (HEIGHT - BOX.height) / 2;
  const middle = HEIGHT / 2;

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true" data-testid="beam-diagram" className="hidden w-full sm:block">
      <defs>
        <linearGradient id="beam-gradient" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="var(--brand-violet)" />
          <stop offset="1" stopColor="var(--brand-cyan)" />
        </linearGradient>
      </defs>

      {steps.slice(1).map((step, offset) => {
        const index = offset + 1;
        const state = index === activeIndex ? "active" : index < activeIndex ? "done" : "idle";
        const from = x(index - 1) + BOX.width;
        const to = x(index);
        const path = `M ${from} ${middle} L ${to} ${middle}`;
        return (
          <g key={step.id}>
            <path d={path} stroke="var(--border)" strokeWidth={1.5} fill="none" />
            {state !== "idle" && (
              <m.path
                key={`${step.id}-${state}`}
                data-beam={step.id}
                data-state={state}
                d={path}
                fill="none"
                stroke="url(#beam-gradient)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray={state === "active" ? "6 8" : undefined}
                opacity={state === "active" ? 1 : 0.5}
                className={cn(state === "active" && "landing-beam")}
                initial={reduced || state === "done" ? false : { opacity: 0 }}
                animate={{ opacity: state === "active" ? 1 : 0.5 }}
                transition={{ duration: 0.35 }}
              />
            )}
            {state === "active" && !reduced && (
              <m.circle
                data-pulse={step.id}
                r={3.5}
                cy={middle}
                fill="var(--brand-cyan)"
                style={{ filter: "drop-shadow(0 0 6px var(--brand-cyan))" }}
                initial={{ cx: from, opacity: 0 }}
                animate={{ cx: [from, to], opacity: [0, 1, 1, 0] }}
                transition={{ duration: 0.9, repeat: Infinity, repeatDelay: 0.25, ease: "easeInOut" }}
              />
            )}
          </g>
        );
      })}

      {/* One highlight for the stage in view, moved rather than redrawn. */}
      <m.rect
        data-highlight=""
        y={y}
        width={BOX.width - 2}
        height={BOX.height}
        rx={12}
        fill="color-mix(in oklch, var(--brand-cyan) 12%, transparent)"
        stroke="var(--brand-cyan)"
        strokeWidth={1.5}
        initial={false}
        animate={{ x: x(activeIndex) + 1 }}
        transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 30 }}
      />

      {steps.map((step, index) => {
        const state = index === activeIndex ? "active" : index < activeIndex ? "done" : "idle";
        return (
          <g key={step.id} data-stage={step.id} data-state={state}>
            <rect
              x={x(index) + 1}
              y={y}
              width={BOX.width - 2}
              height={BOX.height}
              rx={12}
              fill={state === "active" ? "none" : "color-mix(in oklch, var(--card) 70%, transparent)"}
              stroke={state === "done" ? "var(--brand-cyan)" : "var(--border)"}
              strokeOpacity={state === "active" ? 0 : state === "done" ? 0.45 : 1}
              strokeWidth={1.5}
            />
            <text x={x(index) + BOX.width / 2} y={y + 22} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--foreground)">
              {step.tab}
            </text>
            <text textAnchor="middle" fontSize={9} fill="var(--muted-foreground)" fontFamily="var(--font-mono, monospace)">
              {stepKinds(step).map((kind, line) => (
                <tspan key={kind} x={x(index) + BOX.width / 2} y={y + 38 + line * 12}>
                  {kind}
                </tspan>
              ))}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
