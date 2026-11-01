import { useEffect, useMemo, useRef } from "react";
import { createStateReplay, type ExecutionState, type Replay } from "@/domain/execution";
import { useViewStore, type PlaybackSpeed } from "@/store/viewStore";

/** Time per event at 1×. Playback steps through events; it does not reproduce their timing. */
export const PLAYBACK_STEP_MS = 800;

export interface PlaybackView {
  /** The run's replay (one frame per event), or null before the trace loads. */
  replay: Replay | null;
  /** True while a replay position is shown instead of the run as it is now. */
  replaying: boolean;
  playing: boolean;
  /** The frame shown; null when not replaying. */
  index: number | null;
  /** What the views should draw: the replay frame, or the run as it is now. */
  displayed: ExecutionState | undefined;
}

/**
 * Playback over a run's execution state. Derived only: the replay is built
 * from the state's own log through the reducer, and nothing is written back,
 * so the live state keeps receiving events underneath a replay and "back to
 * live" simply shows it again.
 */
export function usePlayback(execution: ExecutionState | undefined): PlaybackView {
  const playback = useViewStore((state) => state.playback);
  const previous = useRef<Replay | null>(null);
  const replay = useMemo(() => {
    if (!execution) return null;
    const next = createStateReplay(execution, previous.current);
    previous.current = next;
    return next;
  }, [execution]);

  const length = replay?.length ?? 0;
  const index = playback && length > 0 ? Math.min(playback.index, length - 1) : null;
  const displayed = index !== null && replay ? replay.stateAtIndex(index) : execution;
  return { replay, replaying: index !== null, playing: Boolean(playback?.playing) && index !== null, index, displayed };
}

/** Advances a playing replay one event per step; pauses at the last event. */
export function usePlaybackClock(length: number, index: number | null, playing: boolean, speed: PlaybackSpeed) {
  const play = useViewStore((state) => state.play);
  const pause = useViewStore((state) => state.pause);
  useEffect(() => {
    if (!playing || index === null) return;
    if (index >= length - 1) {
      pause();
      return;
    }
    const timer = setTimeout(() => play(index + 1), PLAYBACK_STEP_MS / speed);
    return () => clearTimeout(timer);
  }, [playing, index, length, speed, play, pause]);
}
