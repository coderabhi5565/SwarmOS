import { cn } from "@/lib/utils";
import { PIPELINE_NODES, pipelineNode } from "./pipeline";

/**
 * The overlay on the 3D hero: a button per node (so focus can be locked
 * from the keyboard, not only by clicking the scene) and the focused node's
 * telemetry: the names of what SwarmOS records for that role. It sits at
 * the stage's lower right, clear of the headline. Plain DOM: no three.js.
 */
export function HeroHud({
  focused,
  locked,
  onSelect,
}: {
  focused: string | null;
  locked: string | null;
  onSelect: (id: string) => void;
}) {
  const node = focused ? pipelineNode(focused) : null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-end gap-2 p-3 sm:p-5">
      {node && (
        <div
          role="status"
          aria-label={`Telemetry: ${node.label}`}
          className="glass pointer-events-auto w-64 max-w-full rounded-lg px-3 py-2 text-xs shadow-lg"
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
      <div role="group" aria-label="Focus a pipeline node" className="pointer-events-auto flex flex-wrap justify-end gap-1.5">
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
  );
}
