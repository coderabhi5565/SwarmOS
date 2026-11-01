import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TraceEvent } from "@/api/types";
import { fixtures } from "@/domain/execution/fixtures";
import { json, sseResponse, type SseResponse } from "@/test/api";
import { LiveConnections, RECONNECT_DELAYS_MS, STREAM_RETRY_MS, type LiveTarget } from "./liveConnection";

const RUN = "run_live";
const events = fixtures.parallelOverlap.events.map((event) => ({ ...event, run_id: RUN }));

/** A target that records what it was given; its cursor follows what it applied. */
function recordingTarget() {
  const applied: TraceEvent[][] = [];
  const target: LiveTarget & { applied: TraceEvent[][]; endedCount: number } = {
    applied,
    endedCount: 0,
    cursor: () => Math.max(0, ...applied.flat().map((event) => event.seq)),
    apply: (batch) => void applied.push(batch),
    ended: () => void (target.endedCount += 1),
  };
  return target;
}

type Answer = (init?: RequestInit) => Response | Promise<Response>;

/** Stub fetch: each stream request takes the next answer; streams are kept for the test. */
function serveStreams(answers: Answer[]) {
  const streams: SseResponse[] = [];
  const urls: URL[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    urls.push(url);
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected request ${url}`);
    return answer(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  const stream: Answer = (init) => {
    const sse = sseResponse(init);
    streams.push(sse);
    return sse.response;
  };
  return { streams, urls, stream, fetchMock };
}

const networkError: Answer = () => Promise.reject(new TypeError("Failed to fetch"));

let connections: LiveConnections;
let target: ReturnType<typeof recordingTarget>;
let statuses: string[];

function watch() {
  connections = new LiveConnections(() => target);
  statuses = [];
  connections.subscribe(RUN, () => statuses.push(connections.status(RUN)));
  return connections.acquire(RUN);
}

beforeEach(() => {
  target = recordingTarget();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("live connection", () => {
  it("connects, delivers events, and completes on the end message", async () => {
    const server = serveStreams([(init) => server.stream(init)]);
    const release = watch();
    expect(connections.status(RUN)).toBe("connecting");
    await vi.waitFor(() => expect(connections.status(RUN)).toBe("connected"));
    expect(server.urls[0].pathname).toBe(`/api/runs/${RUN}/stream`);
    expect(server.urls[0].searchParams.get("after_seq")).toBe("0");

    server.streams[0].events(events.slice(0, 3));
    server.streams[0].keepalive();
    server.streams[0].events(events.slice(3, 5));
    await vi.waitFor(() => expect(target.applied.flat()).toHaveLength(5));
    // One batch per network chunk; keepalives are not events.
    expect(target.applied.map((batch) => batch.length)).toEqual([3, 2]);

    server.streams[0].end(RUN, "completed", 5);
    await vi.waitFor(() => expect(connections.status(RUN)).toBe("completed"));
    expect(target.endedCount).toBe(1);
    expect(statuses).toEqual(["connecting", "connected", "completed"]);
    release();
    expect(connections.size()).toBe(0);
    expect(server.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resumes from the cursor of what was applied", async () => {
    target.apply(events.slice(0, 7));
    const server = serveStreams([(init) => server.stream(init)]);
    const release = watch();
    await vi.waitFor(() => expect(server.urls).toHaveLength(1));
    expect(server.urls[0].searchParams.get("after_seq")).toBe("7");
    release();
  });

  it("reconnects after a drop, from the last applied event, without repeats", async () => {
    const server = serveStreams([(init) => server.stream(init), (init) => server.stream(init)]);
    const release = watch();
    await vi.waitFor(() => expect(connections.status(RUN)).toBe("connected"));
    server.streams[0].events(events.slice(0, 4));
    await vi.waitFor(() => expect(target.applied.flat()).toHaveLength(4));
    server.streams[0].close(); // the server's stream lifetime, a proxy...

    await vi.waitFor(() => expect(server.urls).toHaveLength(2));
    expect(server.urls[1].searchParams.get("after_seq")).toBe("4");
    await vi.waitFor(() => expect(connections.status(RUN)).toBe("connected"));
    server.streams[1].events(events.slice(4, 6));
    await vi.waitFor(() => expect(target.applied.flat().map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]));
    expect(statuses).toContain("reconnecting");
    release();
  });

  it("backs off on failures, then falls back to polling and later retries the stream", async () => {
    vi.useFakeTimers();
    const server = serveStreams([networkError, networkError, networkError, networkError, (init) => server.stream(init)]);
    const release = watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(connections.status(RUN)).toBe("reconnecting");
    expect(server.urls).toHaveLength(1);

    // Each wait in RECONNECT_DELAYS_MS, then one more failure: polling.
    for (const [index, delay] of RECONNECT_DELAYS_MS.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(server.urls).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(server.urls).toHaveLength(index + 2);
    }
    expect(connections.status(RUN)).toBe("polling");

    await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS);
    expect(server.urls).toHaveLength(5);
    expect(connections.status(RUN)).toBe("connected");
    release();
  });

  it("polls at once when the server has no stream, and retries it later", async () => {
    vi.useFakeTimers();
    const server = serveStreams([() => json({ detail: "not found" }, 404), (init) => server.stream(init)]);
    const release = watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(connections.status(RUN)).toBe("polling");
    await vi.advanceTimersByTimeAsync(STREAM_RETRY_MS);
    expect(connections.status(RUN)).toBe("connected");
    release();
  });

  it("honours Retry-After when there are too many streams", async () => {
    vi.useFakeTimers();
    const server = serveStreams([
      () => json({ detail: "too many" }, 429, { "Retry-After": "5" }),
      (init) => server.stream(init),
    ]);
    const release = watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(connections.status(RUN)).toBe("polling");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(server.urls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connections.status(RUN)).toBe("connected");
    release();
  });

  it("treats a stream that closes at once with nothing as a failure, not a loop", async () => {
    vi.useFakeTimers();
    const server = serveStreams([
      (init) => {
        const response = server.stream(init);
        server.streams.at(-1)!.close();
        return response;
      },
      (init) => server.stream(init),
    ]);
    const release = watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(connections.status(RUN)).toBe("reconnecting");
    expect(server.urls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
    expect(server.urls).toHaveLength(2);
    release();
  });

  it("says when the browser is offline, and reconnects when it is back", async () => {
    const server = serveStreams([networkError, (init) => server.stream(init)]);
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const release = watch();
    await vi.waitFor(() => expect(connections.status(RUN)).toBe("disconnected"));
    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(connections.status(RUN)).toBe("connected"));
    release();
  });

  it("opens one stream per run, however many watch it, and closes it with the last", async () => {
    const server = serveStreams([(init) => server.stream(init)]);
    connections = new LiveConnections(() => target);
    const first = connections.acquire(RUN);
    const second = connections.acquire(RUN);
    await vi.waitFor(() => expect(connections.status(RUN)).toBe("connected"));
    expect(server.fetchMock).toHaveBeenCalledTimes(1);

    first();
    first(); // releasing twice is harmless
    expect(server.streams[0].open).toBe(true);
    second();
    expect(server.streams[0].open).toBe(false);
    expect(connections.size()).toBe(0);
    expect(connections.status(RUN)).toBe("idle");
  });

  it("stops retrying once released", async () => {
    vi.useFakeTimers();
    const server = serveStreams([networkError]);
    const release = watch();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.urls).toHaveLength(1);
    expect(connections.status(RUN)).toBe("idle");
  });
});
