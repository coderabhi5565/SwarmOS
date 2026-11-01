import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunList, RunSummary } from "@/api/types";
import { DEFAULT_LIMITS, json, requestsTo, stubFetch } from "@/test/api";
import { renderAt } from "@/test/render";

function summary(index: number, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: `run_${String(index).padStart(3, "0")}`,
    created_at: `2026-11-01T10:${String(59 - index).padStart(2, "0")}:00+00:00`,
    updated_at: "2026-11-01T11:00:00+00:00",
    goal: `Goal number ${index}`,
    status: "completed",
    provider: "demo",
    provider_kind: "demo",
    model_policy: "config",
    models_by_role: {},
    limits: DEFAULT_LIMITS,
    error: null,
    cost_usd: 0,
    monetary_enforced: false,
    usage_available: false,
    agent_calls: 4,
    escalations: 0,
    revisions: 0,
    duration_ms: 3_800,
    changed_files: ["target.py"],
    plan_step_count: 1,
    review_verdict: "approve",
    verification_passed: true,
    verification_diagnostic: false,
    ...overrides,
  };
}

const firstPage: RunList = {
  runs: [
    summary(1),
    summary(2, { status: "review_invalid", review_verdict: "request_changes", verification_diagnostic: true }),
    summary(3, { status: "running", plan_step_count: null, review_verdict: null, verification_passed: null, verification_diagnostic: null }),
  ],
  next_cursor: "run_003",
};
const secondPage: RunList = { runs: [summary(4), summary(5)], next_cursor: null };

function serve(pages: Record<string, RunList>) {
  return stubFetch((url) => {
    if (url.pathname !== "/api/runs") return undefined;
    return json(pages[url.searchParams.get("cursor") ?? "first"]);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("history", () => {
  it("lists runs with their review and verification results, linking to each run", async () => {
    serve({ first: firstPage });
    renderAt("/history");

    const rows = await screen.findAllByRole("link", { name: /^Run run_/ });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute("href", "/runs/run_001");
    expect(within(rows[0]).getByText("review approved")).toBeInTheDocument();
    expect(within(rows[1]).getByText("invalid review")).toBeInTheDocument();
    expect(within(rows[1]).getByText("diagnostic tests passed")).toBeInTheDocument();
    // A run still in progress: nothing invented.
    expect(within(rows[2]).getByText("in progress")).toBeInTheDocument();
    expect(within(rows[2]).getByText("not reviewed")).toBeInTheDocument();
    expect(within(rows[2]).getByText("not verified")).toBeInTheDocument();
    expect(within(rows[2]).getByText("no plan")).toBeInTheDocument();
  });

  it("loads older pages with the backend cursor", async () => {
    const fetchMock = serve({ first: firstPage, run_003: secondPage });
    renderAt("/history");

    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByRole("link", { name: /^Run run_/ })).toHaveLength(5));
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();

    const calls = requestsTo(fetchMock, "/api/runs");
    expect(calls.map((url) => url.searchParams.get("cursor"))).toEqual([null, "run_003"]);
    expect(calls.every((url) => url.searchParams.get("limit") === "20")).toBe(true);
    // The list never fetches a run's full record or trace.
    expect(fetchMock.mock.calls.some(([input]) => /\/api\/runs\/run_/.test(String(input)))).toBe(false);
  });

  it("shows an empty state", async () => {
    serve({ first: { runs: [], next_cursor: null } });
    renderAt("/history");
    expect(await screen.findByText("No runs yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start a run" })).toHaveAttribute("href", "/runs/new");
  });

  it("shows an error state", async () => {
    stubFetch((url) => (url.pathname === "/api/runs" ? json({ detail: "unknown cursor: run_x" }, 400) : undefined));
    renderAt("/history");
    expect(await screen.findByRole("alert")).toHaveTextContent("unknown cursor: run_x");
  });
});
