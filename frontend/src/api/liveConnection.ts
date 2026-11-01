/**
 * Live transport for running runs: the event stream first, cursor polling
 * as the recovery path.
 *
 * One connection per run per QueryClient, shared by every component that
 * watches the run (reference counted). Received events go through the
 * execution reducer into the same query cache entry the polling path
 * writes (queryKeys.execution); there is no second state. The cursor is the
 * reduced state's lastSeq, so a reconnect resumes after what was actually
 * applied, and an overlap is a no-op in the reducer.
 */
import type { QueryClient } from "@tanstack/react-query";
import { initialState, reduce, type ExecutionState } from "@/domain/execution";
import { ApiError } from "./client";
import { readRunStream } from "./stream";
import type { TraceEvent } from "./types";

export type ConnectionStatus =
  /** Not watching this run (not live, or no one is looking). */
  | "idle"
  /** Opening the stream for the first time. */
  | "connecting"
  /** The stream is open: events arrive as they are recorded. */
  | "connected"
  /** The stream dropped; trying again shortly. */
  | "reconnecting"
  /** The stream is unavailable; polling the events endpoint instead. */
  | "polling"
  /** The browser is offline: nothing can be received. */
  | "disconnected"
  /** The server said the run ended and every event was delivered. */
  | "completed";

/** Waits between failed stream attempts; after these, polling takes over. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000];
/** While polling, how often to try the stream again. */
export const STREAM_RETRY_MS = 30_000;
/** A stream that stayed open this long before closing was healthy. */
const HEALTHY_STREAM_MS = 5_000;

/** Responses that mean "this server has no stream for you": poll at once. */
const NO_STREAM = new Set([404, 405, 429, 501]);

export interface LiveTarget {
  /** Resume after this seq: the last event folded into the state. */
  cursor(): number;
  apply(events: TraceEvent[]): void;
  /** The run is terminal and every event has been delivered. */
  ended(): void;
}

class RunConnection {
  status: ConnectionStatus = "idle";
  refs = 0;
  private failures = 0;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(
    private readonly runId: string,
    private readonly target: LiveTarget,
    private readonly notify: () => void,
  ) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.failures = 0;
    void this.connect("connecting");
  }

  stop() {
    this.stopped = true;
    this.controller?.abort();
    this.controller = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    window.removeEventListener("online", this.online);
    if (this.status !== "completed") this.set("idle");
  }

  private set(status: ConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    this.notify();
  }

  private schedule(delay: number, status: ConnectionStatus) {
    if (this.stopped) return;
    this.set(status);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect(status === "polling" ? "polling" : "reconnecting");
    }, delay);
  }

  private readonly online = () => {
    window.removeEventListener("online", this.online);
    if (!this.stopped) void this.connect("reconnecting");
  };

  private async connect(status: ConnectionStatus) {
    if (this.stopped) return;
    const controller = new AbortController();
    this.controller = controller;
    // While polling, a new attempt keeps showing "polling" until it opens.
    this.set(status);
    let opened = 0;
    let received = false;
    try {
      const outcome = await readRunStream(
        this.runId,
        this.target.cursor(),
        {
          onOpen: () => {
            opened = Date.now();
            this.set("connected");
          },
          onEvents: (events) => {
            received = true;
            this.target.apply(events);
          },
        },
        controller.signal,
      );
      if (controller.signal.aborted || this.stopped) return;
      if (outcome.kind === "ended") {
        this.set("completed");
        this.stopped = true;
        this.target.ended();
        return;
      }
      // Closed without `end` (the server's stream lifetime, a proxy).
      if (received || Date.now() - opened >= HEALTHY_STREAM_MS) {
        this.failures = 0;
        void this.connect("reconnecting");
      } else {
        this.failed();
      }
    } catch (error) {
      if (controller.signal.aborted || this.stopped) return;
      if (error instanceof ApiError && NO_STREAM.has(error.status)) {
        const wait = error.status === 429 && error.retryAfter ? error.retryAfter * 1000 : STREAM_RETRY_MS;
        this.schedule(wait, "polling");
        return;
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        this.set("disconnected");
        window.addEventListener("online", this.online);
        return;
      }
      this.failed();
    }
  }

  private failed() {
    this.failures += 1;
    const delay = RECONNECT_DELAYS_MS[this.failures - 1];
    if (delay === undefined) this.schedule(STREAM_RETRY_MS, "polling");
    else this.schedule(delay, this.status === "polling" ? "polling" : "reconnecting");
  }
}

/** The live connections of one QueryClient. */
export class LiveConnections {
  private readonly connections = new Map<string, RunConnection>();
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(private readonly makeTarget: (runId: string) => LiveTarget) {}

  /** Watch a run; the returned function stops watching. */
  acquire(runId: string): () => void {
    let connection = this.connections.get(runId);
    if (!connection) {
      connection = new RunConnection(runId, this.makeTarget(runId), () => this.emit(runId));
      this.connections.set(runId, connection);
    }
    connection.refs += 1;
    connection.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.connections.get(runId);
      if (!current) return;
      current.refs -= 1;
      if (current.refs > 0) return;
      current.stop();
      this.connections.delete(runId);
      this.emit(runId);
    };
  }

  status(runId: string): ConnectionStatus {
    return this.connections.get(runId)?.status ?? "idle";
  }

  /** Open stream connections (for tests and diagnostics). */
  size(): number {
    return this.connections.size;
  }

  subscribe(runId: string, listener: () => void): () => void {
    let set = this.listeners.get(runId);
    if (!set) this.listeners.set(runId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  private emit(runId: string) {
    for (const listener of this.listeners.get(runId) ?? []) listener();
  }
}

const byClient = new WeakMap<QueryClient, LiveConnections>();

/**
 * The connections for a QueryClient, writing into its cache: events fold
 * into ["execution", runId] through the reducer; when a stream ends, the
 * run record is refreshed (its status turns terminal, which triggers one
 * final events fetch in useExecution).
 */
export function liveConnectionsFor(client: QueryClient): LiveConnections {
  let connections = byClient.get(client);
  if (!connections) {
    connections = new LiveConnections((runId) => {
      const key = ["execution", runId] as const;
      return {
        cursor: () => client.getQueryData<ExecutionState>(key)?.lastSeq ?? 0,
        apply: (events) =>
          client.setQueryData<ExecutionState>(key, (held) => events.reduce(reduce, held ?? initialState())),
        ended: () => void client.invalidateQueries({ queryKey: ["run", runId] }),
      };
    });
    byClient.set(client, connections);
  }
  return connections;
}
