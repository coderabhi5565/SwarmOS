import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { emptyEventLog, mergeEvents } from "@/api/eventLog";
import { useRunEvents } from "@/api/queries";
import { createQueryClient, retryDelay, shouldRetry } from "@/api/queryClient";
import type { TraceEvent } from "@/api/types";

function event(seq: number, kind: TraceEvent["kind"] = "warning"): TraceEvent {
  return { event_id: `evt_${seq}`, run_id: "run_1", seq, at: "2026-11-01T00:00:00Z", kind, message: "", payload: {} };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mergeEvents", () => {
  it("appends new events in seq order and advances the cursor", () => {
    const log = mergeEvents(emptyEventLog("run_1"), { run_id: "run_1", events: [event(1), event(2)], last_seq: 2 });
    const next = mergeEvents(log, { run_id: "run_1", events: [event(3)], last_seq: 3 });
    expect(next.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(next.lastSeq).toBe(3);
    expect(next.finished).toBe(false);
  });

  it("ignores repeated or overlapping pages", () => {
    const log = mergeEvents(emptyEventLog("run_1"), { run_id: "run_1", events: [event(1), event(2)], last_seq: 2 });
    const again = mergeEvents(log, { run_id: "run_1", events: [event(2), event(1)], last_seq: 2 });
    expect(again).toBe(log); // unchanged identity: no re-render for an empty page
    const overlap = mergeEvents(log, { run_id: "run_1", events: [event(2), event(3)], last_seq: 3 });
    expect(overlap.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("marks the log finished when run_finished arrives", () => {
    const log = mergeEvents(emptyEventLog("run_1"), {
      run_id: "run_1",
      events: [event(1), event(2, "run_finished")],
      last_seq: 2,
    });
    expect(log.finished).toBe(true);
  });
});

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

describe("useRunEvents", () => {
  it("fetches the full trace, then only events after the cursor", async () => {
    const pages = [
      { run_id: "run_1", events: [event(1), event(2)], last_seq: 2 },
      { run_id: "run_1", events: [event(3, "run_finished")], last_seq: 3 },
    ];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(pages.shift())),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRunEvents("run_1", { live: false }), { wrapper });

    await waitFor(() => expect(result.current.data?.lastSeq).toBe(2));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/runs/run_1/events");

    await result.current.refetch();
    await waitFor(() => expect(result.current.data?.lastSeq).toBe(3));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/runs/run_1/events?after_seq=2");
    expect(result.current.data?.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(result.current.data?.finished).toBe(true);
  });
});
