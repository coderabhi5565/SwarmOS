import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, apiUrl } from "@/api/client";

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiUrl", () => {
  it("drops unset query values and encodes the rest", () => {
    expect(apiUrl("/api/runs", { limit: 10, cursor: undefined })).toBe("/api/runs?limit=10");
    expect(apiUrl("/api/runs", { cursor: "run a&b" })).toBe("/api/runs?cursor=run+a%26b");
    expect(apiUrl("/health")).toBe("/health");
  });
});

describe("api", () => {
  it("polls events from a cursor", async () => {
    const fetchMock = respond(200, { run_id: "run_1", events: [], last_seq: 7 });
    await api.runEvents("run_1", 7);
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run_1/events?after_seq=7", expect.anything());
  });

  it("omits the cursor for a full trace and escapes run ids", async () => {
    const fetchMock = respond(200, { run_id: "x", events: [], last_seq: 0 });
    await api.runEvents("run/../x");
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run%2F..%2Fx/events", expect.anything());
  });

  it("pages the run list with a cursor", async () => {
    const fetchMock = respond(200, { runs: [], next_cursor: null });
    await api.listRuns({ limit: 20, cursor: "run_9" });
    expect(fetchMock).toHaveBeenCalledWith("/api/runs?limit=20&cursor=run_9", expect.anything());
  });
});

describe("ApiError", () => {
  it("keeps the status, message and Retry-After of a rate-limited request", async () => {
    respond(429, { detail: "run limit reached for this client; retry in 120s" }, { "Retry-After": "120" });
    const error = await api.createRun({ goal: "catalog run", demo_task: "sample_tag_normalization" }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, retryAfter: 120 });
    expect(error.message).toContain("run limit reached");
  });

  it("summarises FastAPI validation errors", async () => {
    respond(422, {
      detail: [{ loc: ["body", "goal"], msg: "String should have at least 8 characters", type: "string_too_short" }],
    });
    const error = await api.createRun({ goal: "short" }).catch((e) => e);
    expect(error.message).toBe("goal: String should have at least 8 characters");
    expect(error.retryAfter).toBeNull();
  });

  it("falls back to the status line for a non-JSON body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" })),
    );
    const error = await api.health().catch((e) => e);
    expect(error).toMatchObject({ status: 502, message: "502 Bad Gateway" });
  });
});
