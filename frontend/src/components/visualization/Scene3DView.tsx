import { RotateCcw } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { Component, lazy, Suspense, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { VizModel } from "@/domain/visualization";
import { cn } from "@/lib/utils";
import { selectionFromNodeId, selectionNodeId, useViewStore } from "@/store/viewStore";
import { nodeDescription } from "./presentation";
import { webglAvailable } from "./webgl";

// The only import of the scene module: three.js and React Three Fiber load
// when this component first renders with WebGL available, never before.
const ExecutionScene3D = lazy(() => import("./ExecutionScene3D"));

/**
 * The 3D view, or, when WebGL is missing or the scene fails, an explanation
 * and the 2D graph (`fallback`) in its place. Selection lives in the shared
 * store, so it survives the fallback and switching views.
 */
export function Scene3DView({ model, live, fallback }: { model: VizModel; live: boolean; fallback: ReactNode }) {
  const [failure, setFailure] = useState<string | null>(() =>
    webglAvailable() ? null : "This browser or device does not provide WebGL.",
  );
  const [resetKey, setResetKey] = useState(0);
  const reducedMotion = useReducedMotion() ?? false;

  if (failure) {
    return (
      <div className="flex size-full flex-col">
        <p role="status" className="border-b border-border/70 px-3 py-2 text-xs text-status-findings">
          3D view unavailable: {failure} Showing the 2D graph instead.
        </p>
        <div className="min-h-0 flex-1">{fallback}</div>
      </div>
    );
  }

  return (
    <div className="relative size-full">
      <SceneBoundary onError={(error) => setFailure(`the 3D scene could not start (${error.message}).`)}>
        <Suspense
          fallback={
            <p role="status" className="grid size-full place-items-center text-sm text-muted-foreground">
              Loading the 3D view…
            </p>
          }
        >
          <ExecutionScene3D
            model={model}
            live={live}
            reducedMotion={reducedMotion}
            resetKey={resetKey}
            onContextLost={() => setFailure("the browser lost the WebGL context.")}
          />
        </Suspense>
      </SceneBoundary>
      <div className="absolute right-2 bottom-2 flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setResetKey((key) => key + 1)}>
          <RotateCcw aria-hidden="true" />
          Reset camera
        </Button>
      </div>
      <SceneNodeList model={model} />
    </div>
  );
}

/**
 * The scene's entities as buttons, for keyboard and screen-reader users:
 * hidden until focused, then shown over the canvas.
 */
function SceneNodeList({ model }: { model: VizModel }) {
  const selectedId = useViewStore((state) => selectionNodeId(state.selection));
  const select = useViewStore((state) => state.select);
  return (
    <nav
      aria-label="Nodes in the 3D view"
      className="sr-only focus-within:not-sr-only focus-within:absolute focus-within:top-2 focus-within:left-2 focus-within:max-h-[calc(100%-1rem)] focus-within:overflow-auto focus-within:rounded-lg focus-within:border focus-within:border-border focus-within:bg-background/95 focus-within:p-2"
    >
      <ul className="space-y-1">
        {model.nodes.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              aria-pressed={node.id === selectedId}
              onClick={() => select(selectionFromNodeId(node.id))}
              className={cn(
                "w-full rounded px-2 py-1 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                node.id === selectedId && "bg-accent",
              )}
            >
              {nodeDescription(node, model.finished)}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

class SceneBoundary extends Component<{ children: ReactNode; onError: (error: Error) => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
