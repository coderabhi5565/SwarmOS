/**
 * Shared view state for the run visualisations (2D graph, 3D scene, trace
 * timeline). Deliberately narrow: server data lives in TanStack Query and the
 * current page in the URL; only what several views must agree on lives here.
 *
 * Zustand (rather than React context) because the 3D scene will read it every
 * frame through getState() without re-rendering the canvas.
 */
import { create } from "zustand";
import { PLANNER_ID, REVIEWER_ID, RUNNER_ID, stepNodeId } from "@/domain/visualization";

/**
 * One entity of the run, as both renderers and the details panel name it.
 * Coder work is selected per step: the coder has no single node.
 */
export type Selection =
  | { kind: "agent"; role: "planner" | "reviewer" }
  | { kind: "step"; stepId: string }
  | { kind: "runner" }
  | null;

export type ViewMode = "3d" | "2d";

export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/**
 * A replay position: the frame index into the run's replay (one frame per
 * event). The views show the state after that event. Null means no replay:
 * the run as it is now, live or finished.
 */
export interface Playback {
  index: number;
  playing: boolean;
}

export interface ViewState {
  /** The run the selection belongs to; another run starts unselected. */
  runId: string | null;
  selection: Selection;
  viewMode: ViewMode;
  /** Keep the views on the newest event while a run is live. */
  followLive: boolean;
  /** Replay of the focused run, if any. Never touches the run's own state. */
  playback: Playback | null;
  playbackSpeed: PlaybackSpeed;

  focusRun: (runId: string) => void;
  select: (selection: Selection) => void;
  clearSelection: () => void;
  setViewMode: (mode: ViewMode) => void;
  setFollowLive: (follow: boolean) => void;
  /** Show the state after frame `index`, paused (enters replay). */
  seek: (index: number) => void;
  play: (fromIndex?: number) => void;
  pause: () => void;
  /** Leave replay: back to the run as it is now. */
  exitPlayback: () => void;
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
}

export const useViewStore = create<ViewState>()((set) => ({
  runId: null,
  selection: null,
  // 2D is the primary view: it needs no WebGL, and the 3D scene's code is
  // only downloaded once someone opts into it.
  viewMode: "2d",
  followLive: true,
  playback: null,
  playbackSpeed: 1,

  focusRun: (runId) =>
    set((state) =>
      state.runId === runId ? state : { runId, selection: null, followLive: true, playback: null },
    ),
  select: (selection) => set((state) => (sameSelection(state.selection, selection) ? state : { selection })),
  clearSelection: () => set({ selection: null }),
  setViewMode: (viewMode) => set({ viewMode }),
  setFollowLive: (followLive) => set({ followLive }),
  seek: (index) => set({ playback: { index: Math.max(0, Math.floor(index)), playing: false } }),
  play: (fromIndex) =>
    set((state) => ({
      playback: { index: Math.max(0, Math.floor(fromIndex ?? state.playback?.index ?? 0)), playing: true },
    })),
  pause: () => set((state) => (state.playback ? { playback: { ...state.playback, playing: false } } : state)),
  exitPlayback: () => set({ playback: null }),
  setPlaybackSpeed: (playbackSpeed) => set({ playbackSpeed }),
}));

/** The visualisation node id a selection points at (see domain/visualization). */
export function selectionNodeId(selection: Selection): string | null {
  if (!selection) return null;
  if (selection.kind === "agent") return selection.role === "planner" ? PLANNER_ID : REVIEWER_ID;
  if (selection.kind === "step") return stepNodeId(selection.stepId);
  return RUNNER_ID;
}

/** The selection for a visualisation node id; null for an unknown id. */
export function selectionFromNodeId(id: string): Selection {
  if (id === PLANNER_ID) return { kind: "agent", role: "planner" };
  if (id === REVIEWER_ID) return { kind: "agent", role: "reviewer" };
  if (id === RUNNER_ID) return { kind: "runner" };
  if (id.startsWith("step:") && id.length > 5) return { kind: "step", stepId: id.slice(5) };
  return null;
}

function sameSelection(a: Selection, b: Selection): boolean {
  return selectionNodeId(a) === selectionNodeId(b);
}
