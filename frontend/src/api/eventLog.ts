import type { RunEvents, TraceEvent } from "./types";

/** A run's trace as accumulated by cursor polling. */
export interface EventLog {
  runId: string;
  events: TraceEvent[];
  /** The cursor for the next poll: the highest seq seen so far. */
  lastSeq: number;
  /** True once a run_finished event has arrived; polling can stop. */
  finished: boolean;
}

export function emptyEventLog(runId: string): EventLog {
  return { runId, events: [], lastSeq: 0, finished: false };
}

/**
 * Fold one page from GET /events?after_seq= into the log.
 *
 * Keeps events in seq order and ignores any seq already held, so an
 * overlapping or repeated page (a retried request, a cursor that raced a
 * write) can never duplicate or reorder the trace.
 */
export function mergeEvents(log: EventLog, page: RunEvents): EventLog {
  const known = new Set(log.events.map((event) => event.seq));
  const fresh = page.events.filter((event) => !known.has(event.seq));
  if (fresh.length === 0) {
    return log;
  }
  const events = [...log.events, ...fresh].sort((a, b) => a.seq - b.seq);
  return {
    runId: log.runId,
    events,
    lastSeq: Math.max(log.lastSeq, page.last_seq, events[events.length - 1].seq),
    finished: log.finished || fresh.some((event) => event.kind === "run_finished"),
  };
}
