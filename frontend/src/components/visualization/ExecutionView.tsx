import { Box, Network, Pause, Play } from "lucide-react";
import { Section } from "@/components/execution/primitives";
import { Button } from "@/components/ui/button";
import type { ExecutionState } from "@/domain/execution";
import type { VizModel } from "@/domain/visualization";
import { useViewStore, type ViewMode } from "@/store/viewStore";
import { ExecutionGraph2D } from "./ExecutionGraph2D";
import { NodeDetails } from "./NodeDetails";
import { Scene3DView } from "./Scene3DView";
import { useVizModel } from "./useVizModel";

const MODES: { mode: ViewMode; label: string; icon: typeof Box }[] = [
  { mode: "2d", label: "2D graph", icon: Network },
  { mode: "3d", label: "3D scene", icon: Box },
];

/**
 * The run's execution as a graph, in 2D or 3D, with the selected node's
 * details. Both views draw the same model and share the selection, so
 * switching between them keeps what is selected.
 */
export function ExecutionView({ state, live }: { state: ExecutionState; live: boolean }) {
  const model = useVizModel(state);
  const viewMode = useViewStore((store) => store.viewMode);
  const setViewMode = useViewStore((store) => store.setViewMode);
  const followLive = useViewStore((store) => store.followLive);
  const setFollowLive = useViewStore((store) => store.setFollowLive);
  const graph = <ExecutionGraph2D model={model} live={live} />;

  return (
    <Section
      id="execution-graph"
      title="Execution graph"
      description="Planner, coder steps by wave, reviewer and the deterministic verifier. Select a node for its details."
      action={
        <div className="flex flex-wrap items-center gap-2">
          {live && (
            <Button variant="ghost" size="sm" aria-pressed={followLive} onClick={() => setFollowLive(!followLive)}>
              {followLive ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              {followLive ? "Following live" : "Follow live"}
            </Button>
          )}
          <div role="group" aria-label="View" className="inline-flex rounded-lg border border-border p-0.5">
            {MODES.map(({ mode, label, icon: Icon }) => (
              <Button
                key={mode}
                variant={viewMode === mode ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={viewMode === mode}
                onClick={() => setViewMode(mode)}
              >
                <Icon aria-hidden="true" />
                {label}
              </Button>
            ))}
          </div>
        </div>
      }
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="h-[26rem] min-w-0 overflow-hidden rounded-lg border border-border/70 bg-background/40">
          {viewMode === "3d" ? <Scene3DView model={model} live={live} fallback={graph} /> : graph}
        </div>
        <NodeDetails state={state} model={model} />
      </div>
      <GraphNotes model={model} />
    </Section>
  );
}

const LEGEND = [
  { label: "dependency", className: "border-brand-cyan" },
  { label: "hand-off", className: "border-muted-foreground/60" },
  { label: "revision", className: "border-dashed border-status-findings" },
  { label: "repair", className: "border-dashed border-status-failed" },
];

/** The legend, and what the trace could not establish. */
function GraphNotes({ model }: { model: VizModel }) {
  const ranWork = model.nodes.some((node) => node.attempts > 0);
  const hasSteps = model.nodes.some((node) => node.kind === "step");
  return (
    <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
      <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Edge legend">
        {LEGEND.map((item) => (
          <li key={item.label} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={`inline-block w-5 border-t-2 ${item.className}`} />
            {item.label}
          </li>
        ))}
      </ul>
      {!model.lifecycleRecorded && ranWork && (
        <p>This trace predates start events: results are shown, but not when work was running.</p>
      )}
      {hasSteps && !model.dependenciesKnown && (
        <p>Step dependencies were not recorded; steps are grouped by wave only, with no dependency edges.</p>
      )}
    </div>
  );
}
