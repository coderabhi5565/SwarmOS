import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { executionPollInterval, LIVE_EVENTS_POLL_MS, useExecution } from "@/api/queries";
import { createQueryClient, retryDelay, shouldRetry } from "@/api/queryClient";
import { initialState, replay } from "@/domain/execution";
import { fixtures } from "@/domain/execution/fixtures";
import { liveConnectionsFor } from "@/api/liveConnection";
import { eventsPage, json, requestsTo, runDetailFrom, sseResponse, stubFetch, type SseResponse } from "@/test/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrapper(client = createQueryClient()) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("retry policy", () => {
  it("retries network failures and 5xx, never 4xx", () => {
    expect(shouldRetry(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetry(0, new ApiError(503, "waking", null, null))).toBe(true);
    for (const status of [400, 403, 404, 422, 429]) {
      expect(shouldRetry(0, new ApiError(status, "no", null, null))).toBe(false);
    }
    expect(shouldRetry(4, new TypeError("Failed to fetch"))).toBe(false);
  });

  it("backs off exponentially up to a cap", () => {
    expect([0, 1, 2, 3, 10].map(retryDelay)).toEqual([1000, 2000, 4000, 8000, 15000]);
  });
});

describe("executionPollInterval", () => {
  const finished = replay(fixtures.demoPipelineCompleted.events);

  it("polls only while the run is live and unfinished", () => {
    expect(executionPollInterval("running", initialState())).toBe(LIVE_EVENTS_POLL_MS);
    expect(executionPollInterval("queued", undefined)).toBe(LIVE_EVENTS_POLL_MS);
    expect(executionPollInterval("completed", initialState())).toBe(false);
    // run_finished arrived before the record caught up: stop anyway.
    expect(executionPollInterval("running", finished)).toBe(false);
  });
});

describe("useExecution", () => {
  const fixture = fixtures.parallelOverlap;
  const runId = fixture.run.run_id;
  const split = 9; // events after this seq arrive on the second poll

  it("folds cursor pages through the reducer, without reprocessing events", async () => {
    let served = split;
    const fetchMock = stubFetch((url) => {
      if (url.pathname === `/api/runs/${runId}`) return json(runDetailFrom(fixture, { status: "running" }));
      if (url.pathname === `/api/runs/${runId}/events`) {
        const after = url.searchParams.get("after_seq");
        const visible = fixture.events.filter((event) => event.seq <= served);
        // The second page overlaps the first: a duplicate must change nothing.
        const cursor = after === null ? null : Number(after) - 2;
        return json(eventsPage(runId, visible, cursor));
      }
      return undefined;
    });

    const { result } = renderHook(() => useExecution(runId), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.execution?.lastSeq).toBe(split));
    // At seq 9 alpha has finished and beta is still in flight.
    const mid = result.current.execution!;
    expect(mid.agents.coder.activeInvocationIds.map((id) => mid.invocations[id].stepId)).toEqual(["beta"]);
    expect(requestsTo(fetchMock, `/api/runs/${runId}/events`)[0].search).toBe("");

    served = fixture.events.length;
    await result.current.trace.refetch();
    await waitFor(() => expect(result.current.execution?.outcome?.status).toBe("completed"));

    const polls = requestsTo(fetchMock, `/api/runs/${runId}/events`);
    expect(polls[1].searchParams.get("after_seq")).toBe(String(split));
    // Identical to replaying the trace once: nothing applied twice.
    expect(result.current.execution).toEqual(replay(fixture.events, { seed: result.current.execution!.seed }));
  });

  it("closes a terminal run with no run_finished from its record", async () => {
    const crashed = fixture.events.filter((event) => event.kind !== "run_finished");
    stubFetch((url) => {
      if (url.pathname === `/api/runs/${runId}`) return json(runDetailFrom(fixture, { status: "failed" }));
      if (url.pathname === `/api/runs/${runId}/events`) return json(eventsPage(runId, crashed, null));
      return undefined;
    });
    const { result } = renderHook(() => useExecution(runId), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.execution?.outcome).toMatchObject({ status: "failed", source: "record" }));
    expect(result.current.execution?.agents.coder.activeInvocationIds).toEqual([]);
    expect(result.current.live).toBe(false);
  });

  it("does not fetch events before the run record is known", async () => {
    const fetchMock = stubFetch((url) =>
      url.pathname === `/api/runs/${runId}` ? json({ detail: "run not found" }, 404) : undefined,
    );
    const { result } = renderHook(() => useExecution(runId), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.record.isError).toBe(true));
    expect(requestsTo(fetchMock, `/api/runs/${runId}/events`)).toEqual([]);
  });
});

describe("useExecution over the event stream", () => {
  const fixture = fixtures.parallelOverlap;
  const runId = fixture.run.run_id;
  const split = 5; // the first load returns events up to here; the stream sends the rest

  function serveLive() {
    const served = { status: "running" as "running" | "completed" };
    const streams: SseResponse[] = [];
    const fetchMock = stubFetch((url, init) => {
      if (url.pathname === `/api/runs/${runId}`) return json(runDetailFrom(fixture, { status: served.status }));
      if (url.pathname === `/api/runs/${runId}/events`) {
        const after = url.searchParams.get("after_seq");
        const visible = served.status === "running" ? fixture.events.filter((e) => e.seq <= split) : fixture.events;
        return json(eventsPage(runId, visible, after === null ? null : Number(after)));
      }
      if (url.pathname === `/api/runs/${runId}/stream`) {
        const stream = sseResponse(init);
        streams.push(stream);
        return stream.response;
      }
      return undefined;
    });
    return { served, streams, fetchMock };
  }

  it("streams a live run through the reducer, then settles it once", async () => {
    const { served, streams, fetchMock } = serveLive();
    const client = createQueryClient();
    const { result } = renderHook(() => useExecution(runId), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.connection).toBe("connected"));
    expect(result.current.execution?.lastSeq).toBe(split);
    // The stream resumes after what the first load reduced.
    const opened = requestsTo(fetchMock, `/api/runs/${runId}/stream`);
    expect(opened).toHaveLength(1);
    expect(opened[0].searchParams.get("after_seq")).toBe(String(split));

    const rest = fixture.events.filter((e) => e.seq > split);
    streams[0].events(rest.slice(0, 3));
    await waitFor(() => expect(result.current.execution?.lastSeq).toBe(split + 3));
    // A repeated and overlapping delivery changes nothing.
    streams[0].events(fixture.events.slice(split - 2, split + 3));
    streams[0].events(rest.slice(3));
    await waitFor(() => expect(result.current.execution?.lastSeq).toBe(fixture.events.at(-1)!.seq));

    // While streaming, neither the record nor the events are polled.
    const recordFetches = requestsTo(fetchMock, `/api/runs/${runId}`).length;
    const eventFetches = requestsTo(fetchMock, `/api/runs/${runId}/events`).length;
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    expect(requestsTo(fetchMock, `/api/runs/${runId}`)).toHaveLength(recordFetches);
    expect(requestsTo(fetchMock, `/api/runs/${runId}/events`)).toHaveLength(eventFetches);

    served.status = "completed";
    streams[0].end(runId, "completed", fixture.events.at(-1)!.seq);
    await waitFor(() => expect(result.current.live).toBe(false));
    await waitFor(() => expect(result.current.trace.isFetching).toBe(false));
    expect(result.current.execution).toEqual(replay(fixture.events, { seed: result.current.execution!.seed }));
    // The stream is closed and released; nothing reopens it.
    expect(liveConnectionsFor(client).size()).toBe(0);
    expect(requestsTo(fetchMock, `/api/runs/${runId}/stream`)).toHaveLength(1);
  }, 10_000);

  it("never opens a stream for a finished run", async () => {
    const fetchMock = stubFetch((url) => {
      if (url.pathname === `/api/runs/${runId}`) return json(runDetailFrom(fixture, { status: "completed" }));
      if (url.pathname === `/api/runs/${runId}/events`) return json(eventsPage(runId, fixture.events, null));
      return undefined;
    });
    const { result } = renderHook(() => useExecution(runId), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.execution?.outcome?.status).toBe("completed"));
    expect(result.current.connection).toBe("idle");
    expect(requestsTo(fetchMock, `/api/runs/${runId}/stream`)).toEqual([]);
  });

  it("closes the stream when the component unmounts", async () => {
    const { streams } = serveLive();
    const client = createQueryClient();
    const { result, unmount } = renderHook(() => useExecution(runId), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.connection).toBe("connected"));
    unmount();
    expect(streams[0].open).toBe(false);
    expect(liveConnectionsFor(client).size()).toBe(0);
  });

  it("falls back to cursor polling when the server has no stream", async () => {
    const { fetchMock } = serveLive();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === `/api/runs/${runId}/stream`) return json({ detail: "Not Found" }, 404);
      if (url.pathname === `/api/runs/${runId}`) return json(runDetailFrom(fixture, { status: "running" }));
      if (url.pathname === `/api/runs/${runId}/events`) {
        const after = url.searchParams.get("after_seq");
        return json(eventsPage(runId, fixture.events.filter((e) => e.seq <= split), after === null ? null : Number(after)));
      }
      return json({ detail: "not found" }, 404);
    });
    const { result } = renderHook(() => useExecution(runId), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.connection).toBe("polling"));
    const before = requestsTo(fetchMock, `/api/runs/${runId}/events`).length;
    await waitFor(() => expect(requestsTo(fetchMock, `/api/runs/${runId}/events`).length).toBeGreaterThan(before), {
      timeout: 3_000,
    });
    // Polling resumes from the cursor, like the stream would.
    expect(requestsTo(fetchMock, `/api/runs/${runId}/events`).at(-1)!.searchParams.get("after_seq")).toBe(String(split));
  });
});
