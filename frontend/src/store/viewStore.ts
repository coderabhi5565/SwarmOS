/**
 * Shared view state for the run visualisations (2D graph, 3D scene, trace
 * timeline). Deliberately narrow: server data lives in TanStack Query and the
 * current page in the URL; only what several views must agree on lives here.
 *
 * Zustand (rather than React context) because the 3D scene will read it every
 * frame through getState() without re-rendering the canvas.
 */
import { create } from "zustand";
import type { TraceEventPayloads } from "@/api/types";

export type AgentRole = TraceEventPayloads["agent_started"]["role"];

export type Selection =
  | { kind: "agent"; role: AgentRole }
  | { kind: "step"; stepId: string }
  | null;

export type ViewMode = "3d" | "2d";

export interface ViewState {
  /** The run the selection belongs to; another run starts unselected. */
  runId: string | null;
  selection: Selection;
  viewMode: ViewMode;
  /** Keep the views on the newest event while a run is live. */
  followLive: boolean;

  focusRun: (runId: string) => void;
  select: (selection: Selection) => void;
  clearSelection: () => void;
  setViewMode: (mode: ViewMode) => void;
  setFollowLive: (follow: boolean) => void;
}

/** 2D by default when the user asks the OS for reduced motion. */
export function defaultViewMode(): ViewMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "3d";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "2d" : "3d";
}

export const useViewStore = create<ViewState>()((set) => ({
  runId: null,
  selection: null,
  viewMode: defaultViewMode(),
  followLive: true,

  focusRun: (runId) =>
    set((state) => (state.runId === runId ? state : { runId, selection: null, followLive: true })),
  select: (selection) => set({ selection }),
  clearSelection: () => set({ selection: null }),
  setViewMode: (viewMode) => set({ viewMode }),
  setFollowLive: (followLive) => set({ followLive }),
}));
