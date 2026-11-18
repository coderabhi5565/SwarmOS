import { cn } from "@/lib/utils";
import { PIPELINE_NODES, pipelineNode } from "./pipeline";
import { PHASES, type PhaseId } from "./simulation";

/**
 * The overlay on the 3D hero: the phase the cycle is showing, a button per
 * node (so focus can be locked from the keyboard, not only by clicking the
 * scene), and the focused node's telemetry: the names of what SwarmOS
 * records for that role. Plain DOM: no three.js.
 */
export function HeroHud({
  phase,
  focused,
  locked,
  onSelect,
}: {
  phase: PhaseId;
  focused: string | null;
  locked: string | null;
  onSelect: (id: string) => void;
}) {
  const node = focused ? pipelineNode(focused) : null;
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3">
      <ol aria-label="Execution cycle" className="flex flex-wrap gap-1.5 font-mono text-[10px]">
        {PHASES.map((item, index) => (
          <li
            key={item.id}
            aria-current={item.id === phase ? "step" : undefined}
            className={cn(
              "rounded-full border px-2 py-0.5 transition-colors",
              item.id === phase ? "border-brand-cyan/60 bg-brand-cyan/10 text-foreground" : "border-border/60 text-muted-foreground",
            )}
          >
            {index + 1} {item.label}
            {item.id === phase && <span className="text-muted-foreground"> · {item.detail}</span>}
          </li>
        ))}
      </ol>

      <div className="flex flex-col gap-2">
        {node && (
          <div
            role="status"
            aria-label={`Telemetry: ${node.label}`}
            className="glass pointer-events-auto w-64 max-w-full self-start rounded-lg px-3 py-2 text-xs shadow-lg"
          >
            <p className="flex items-center gap-2 font-medium text-foreground">
              <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: node.color }} />
              {node.label}
              {locked === node.id && <span className="font-mono text-[10px] text-brand-cyan">locked</span>}
            </p>
            <p className="mt-1 text-muted-foreground">{node.description}</p>
            <ul className="mt-2 space-y-0.5 font-mono text-[10px] text-foreground/90">
              {node.telemetry.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
        <div role="group" aria-label="Focus a pipeline node" className="pointer-events-auto flex flex-wrap gap-1.5">
          {PIPELINE_NODES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={locked === item.id}
              onClick={() => onSelect(item.id)}
              className={cn(
                "rounded-md border px-2 py-1 font-mono text-[10px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                locked === item.id
                  ? "border-foreground/50 bg-accent text-accent-foreground"
                  : "border-border/60 bg-background/50 text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
