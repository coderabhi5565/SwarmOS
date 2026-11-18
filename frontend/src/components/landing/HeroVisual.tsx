import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { HeroPipeline2D } from "./HeroPipeline2D";
import { PIPELINE_NODES } from "./pipeline";
import type { PhaseId } from "./simulation";

// The only import of the scene module: three.js and React Three Fiber are
// requested when this component renders with WebGL2 and motion allowed,
// never before.
const HeroScene3D = lazy(() => import("./HeroScene3D"));

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/**
 * Whether this browser can create a WebGL2 context (three.js needs one).
 * A browser without the WebGL2 interface is answered without creating a
 * canvas context, so nothing is logged.
 */
export function webgl2Available(): boolean {
  if (typeof WebGL2RenderingContext === "undefined") return false;
  try {
    return document.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    return false;
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches;
}

/** Why the 2D diagram is shown instead of the 3D scene. */
export type HeroFallback = "no-webgl2" | "reduced-motion" | "context-lost" | "scene-error";

/**
 * The landing hero's visual: the 3D pipeline when the browser has WebGL2
 * and the visitor has not asked for reduced motion; otherwise, and while the
 * 3D chunk loads, if the context is lost or if the scene fails, the 2D
 * diagram. The pipeline is also listed for assistive technology.
 */
export function HeroVisual({
  className,
  fallbackClassName,
  onPhase,
}: {
  className?: string;
  /** Layout of the 2D diagram (the 3D scene always fills the visual). */
  fallbackClassName?: string;
  /** The phase the 3D scene's execution cycle is playing; null once the 2D diagram is shown. */
  onPhase?: (phase: PhaseId | null) => void;
}) {
  const [fallback, setFallback] = useState<HeroFallback | null>(() =>
    !webgl2Available() ? "no-webgl2" : prefersReducedMotion() ? "reduced-motion" : null,
  );

  // Follow the OS setting if it changes while the page is open.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_MOTION);
    const onChange = () => {
      if (query.matches) setFallback((current) => current ?? "reduced-motion");
    };
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  // The 2D diagram plays no cycle: whoever follows the phase is told so.
  useEffect(() => {
    if (fallback) onPhase?.(null);
  }, [fallback, onPhase]);

  return (
    <div className={cn("relative isolate", className)} data-hero={fallback ?? "3d"}>
      {fallback ? (
        <HeroPipeline2D className={fallbackClassName} />
      ) : (
        <SceneBoundary onError={() => setFallback("scene-error")}>
          <Suspense fallback={<HeroPipeline2D className={fallbackClassName} />}>
            <HeroScene3D onContextLost={() => setFallback("context-lost")} onPhase={onPhase} />
          </Suspense>
        </SceneBoundary>
      )}
      {!fallback && (
        <ol className="sr-only" aria-label="SwarmOS pipeline">
          {PIPELINE_NODES.map((node) => (
            <li key={node.id}>
              {node.label}: {node.description}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

class SceneBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
