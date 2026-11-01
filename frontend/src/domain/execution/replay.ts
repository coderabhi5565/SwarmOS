/**
 * Historical replay on top of the reducer. Playback controls can be added
 * later by driving `createReplay` (frame index or seq); the reducer itself
 * needs no changes for that.
 */
import type { TraceEvent } from "@/api/types";
import type { ExecutionState, RunSeed } from "./model";
import { initialState, reduce, settleWithRecord } from "./reducer";

/** Sort by seq and drop repeated seqs (the first copy wins, as in the reducer). */
export function orderedEvents(events: readonly TraceEvent[]): TraceEvent[] {
  const seen = new Set<number>();
  return [...events]
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.seq - b.event.seq || a.index - b.index)
    .flatMap(({ event }) => {
      if (seen.has(event.seq)) return [];
      seen.add(event.seq);
      return [event];
    });
}

export interface ReplayOptions {
  seed?: RunSeed | null;
  /** Replay only events with seq <= untilSeq. */
  untilSeq?: number;
  /**
   * After a full replay, close a trace that never reached run_finished
   * using the stored record (see settleWithRecord). Ignored with untilSeq.
   */
  settle?: boolean;
}

/** The state after replaying `events` from the start. */
export function replay(events: readonly TraceEvent[], options: ReplayOptions = {}): ExecutionState {
  const { seed = null, untilSeq, settle = false } = options;
  const selected = orderedEvents(events).filter((event) => untilSeq === undefined || event.seq <= untilSeq);
  const state = selected.reduce(reduce, initialState(seed));
  return settle && untilSeq === undefined ? settleWithRecord(state) : state;
}

export interface Replay {
  /** The seqs available, ascending: one frame per seq. */
  readonly seqs: readonly number[];
  readonly length: number;
  /** The state before any event. */
  readonly initial: ExecutionState;
  /** State after frame `index` (0-based); -1 is the initial state. */
  stateAtIndex(index: number): ExecutionState;
  /** State after the last event with seq <= `seq`. */
  stateAt(seq: number): ExecutionState;
  /** State after every event. */
  final(): ExecutionState;
}

/**
 * A scrubbable replay. Frames are computed lazily, forward from the nearest
 * one already known, and memoised: moving back and forth costs each frame
 * once, and the same position always returns the same object.
 */
export function createReplay(events: readonly TraceEvent[], seed: RunSeed | null = null): Replay {
  const ordered = orderedEvents(events);
  const seqs = ordered.map((event) => event.seq);
  const initial = initialState(seed);
  const frames: ExecutionState[] = [];

  function stateAtIndex(index: number): ExecutionState {
    if (index < 0 || ordered.length === 0) return initial;
    const target = Math.min(index, ordered.length - 1);
    let state = frames.length > 0 ? frames[frames.length - 1] : initial;
    for (let i = frames.length; i <= target; i += 1) {
      state = reduce(state, ordered[i]);
      frames.push(state);
    }
    return frames[target];
  }

  function stateAt(seq: number): ExecutionState {
    // The last frame whose seq is <= seq (binary search).
    let low = 0;
    let high = seqs.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (seqs[mid] <= seq) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return stateAtIndex(found);
  }

  return {
    seqs,
    length: seqs.length,
    initial,
    stateAtIndex,
    stateAt,
    final: () => stateAtIndex(seqs.length - 1),
  };
}
