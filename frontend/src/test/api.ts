/**
 * Test helpers that serve recorded traces through the real API contract.
 * Records are typed as the generated RunRecord, so a contract change breaks
 * these helpers at compile time rather than letting tests drift.
 */
import { vi } from "vitest";
import type { RunDetail, RunEvents, RunRecord, TraceEvent } from "@/api/types";
import type { TraceFixture } from "@/domain/execution/fixtures";

export const DEFAULT_LIMITS: RunRecord["limits"] = {
  max_agent_calls: 12,
  max_budget_usd: 0.25,
  max_wall_seconds: 120,
  max_retries: 2,
  max_revisions: 1,
  max_escalations: 1,
  parallel_coding: true,
};

/** A run record for a recorded trace. Counters the seed does not carry are zero. */
export function runRecordFrom(fixture: TraceFixture, overrides: Partial<RunRecord> = {}): RunRecord {
  const run = fixture.run;
  const created = run.created_at ?? "2026-11-01T10:00:00+00:00";
  return {
    run_id: run.run_id,
    created_at: created,
    updated_at: created,
    goal: run.goal ?? "",
    provider: run.provider ?? "demo",
    provider_kind: (run.provider_kind ?? "unknown") as RunRecord["provider_kind"],
    provider_warning: null,
    status: run.status ?? "running",
    limits: { ...DEFAULT_LIMITS, ...(run.limits ?? {}) },
    model_policy: run.model_policy ?? "config",
    models_by_role: run.models_by_role ?? {},
    plan: run.plan ?? null,
    review: null,
    verification: null,
    summary: "",
    error: null,
    cost_usd: 0,
    monetary_enforced: false,
    usage_available: false,
    agent_calls: 0,
    escalations: 0,
    revisions: 0,
    duration_ms: 0,
    changed_files: [],
    artifacts: {},
    ...overrides,
  };
}

export function runDetailFrom(fixture: TraceFixture, overrides: Partial<RunRecord> = {}): RunDetail {
  return { run: runRecordFrom(fixture, overrides), events: fixture.events };
}

/** The events endpoint's answer for a cursor, from a list of events. */
export function eventsPage(runId: string, events: TraceEvent[], afterSeq: number | null): RunEvents {
  const page = events.filter((event) => afterSeq === null || event.seq > afterSeq);
  return { run_id: runId, events: page, last_seq: page.at(-1)?.seq ?? afterSeq ?? 0 };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export type Route = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;

/**
 * Stub fetch with a router. Unmatched requests answer 404 like FastAPI, so a
 * test that forgets a route fails visibly instead of hanging.
 */
export function stubFetch(route: Route) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    return (await route(url, init)) ?? json({ detail: "not found" }, 404);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

export function requestsTo(mock: ReturnType<typeof stubFetch>, path: string): URL[] {
  return mock.mock.calls
    .map(([input]) => new URL(String(input), "http://localhost"))
    .filter((url) => url.pathname === path);
}
