import { useMemo, useRef } from "react";
import type { ExecutionState } from "@/domain/execution";
import { buildVizModel, reconcileVizModel, type VizModel } from "@/domain/visualization";

/**
 * The visualisation model for an execution state. Rebuilt only when the
 * state object changes (the reducer keeps it when a poll brings nothing new),
 * and reconciled with the previous model so unchanged nodes and edges keep
 * their identity and memoised renderers skip them.
 */
export function useVizModel(state: ExecutionState): VizModel {
  const previous = useRef<VizModel | null>(null);
  return useMemo(() => {
    const next = reconcileVizModel(previous.current, buildVizModel(state));
    previous.current = next;
    return next;
  }, [state]);
}
