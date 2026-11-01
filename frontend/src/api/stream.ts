/**
 * One connection to a run's live event stream (GET /api/runs/{id}/stream).
 *
 * fetch rather than EventSource: it can carry the same headers as every
 * other request, and the caller decides where to resume (from the state it
 * has actually reduced) and when to reconnect.
 */
import { apiUrl, toApiError } from "./client";
import { createSseParser } from "./sse";
import type { RunStreamEnd, TraceEvent } from "./types";

export interface StreamHandlers {
  /** The server accepted the stream. */
  onOpen?: () => void;
  /** Events, in the order received; one call per network chunk. */
  onEvents: (events: TraceEvent[]) => void;
}

/**
 * "ended": the server sent `end`, every event has been delivered.
 * "closed": the connection ended without `end` (the server's stream
 * lifetime, a proxy); reconnect from the last event to continue.
 */
export type StreamOutcome = { kind: "ended"; end: RunStreamEnd } | { kind: "closed" };

/**
 * Read the stream until it ends. Rejects with an ApiError for an HTTP error
 * response, or with the network error; an abort rejects with AbortError.
 */
export async function readRunStream(
  runId: string,
  afterSeq: number,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<StreamOutcome> {
  const response = await fetch(apiUrl(`/api/runs/${encodeURIComponent(runId)}/stream`, { after_seq: afterSeq }), {
    headers: { Accept: "text/event-stream" },
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw await toApiError(response);
  if (!response.body) throw new TypeError("the stream response has no body");
  handlers.onOpen?.();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { kind: "closed" };
      const events: TraceEvent[] = [];
      let end: RunStreamEnd | null = null;
      for (const message of parser.push(decoder.decode(value, { stream: true }))) {
        if (message.event === "trace") events.push(JSON.parse(message.data) as TraceEvent);
        else if (message.event === "end") end = JSON.parse(message.data) as RunStreamEnd;
      }
      if (events.length > 0) handlers.onEvents(events);
      if (end) return { kind: "ended", end };
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
