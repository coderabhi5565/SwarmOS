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
 * The walkthrough's stages as a row of boxes joined by beams. The stage in
 * view is lit, the beam leading into it carries moving dashes (static under
 * reduced motion), and stages already passed stay marked. Each box names the
 * event kinds its recorded excerpts show. A picture of the tabs below it,
 * so it is hidden from assistive technology: the tabs carry the meaning.
 */
export function BeamDiagram({ steps, activeIndex }: { steps: WalkthroughStep[]; activeIndex: number }) {
  const gap = (WIDTH - steps.length * BOX.width) / (steps.length - 1);
  const x = (index: number) => index * (BOX.width + gap);
  const y = (HEIGHT - BOX.height) / 2;

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true" data-testid="beam-diagram" className="hidden w-full sm:block">
      {steps.slice(1).map((step, offset) => {
        const index = offset + 1;
        const state = index === activeIndex ? "active" : index < activeIndex ? "done" : "idle";
        return (
          <g key={step.id}>
            <line
              x1={x(index - 1) + BOX.width}
              y1={HEIGHT / 2}
              x2={x(index)}
              y2={HEIGHT / 2}
              stroke="var(--border)"
              strokeWidth={1.5}
            />
            {state !== "idle" && (
              <line
                data-beam={step.id}
                data-state={state}
                x1={x(index - 1) + BOX.width}
                y1={HEIGHT / 2}
                x2={x(index)}
                y2={HEIGHT / 2}
                stroke="var(--brand-cyan)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray={state === "active" ? "6 8" : undefined}
                opacity={state === "active" ? 1 : 0.45}
                className={cn(state === "active" && "landing-beam")}
              />
            )}
          </g>
        );
      })}
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
              fill={state === "active" ? "color-mix(in oklch, var(--brand-cyan) 12%, transparent)" : "color-mix(in oklch, var(--card) 70%, transparent)"}
              stroke={state === "idle" ? "var(--border)" : "var(--brand-cyan)"}
              strokeOpacity={state === "done" ? 0.45 : 1}
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
