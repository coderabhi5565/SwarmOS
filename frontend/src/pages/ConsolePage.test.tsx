import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Health, RunRecord, RunStatus } from "@/api/types";
import { fixtures, type TraceFixture } from "@/domain/execution/fixtures";
import { useViewStore } from "@/store/viewStore";
import { eventsPage, json, requestsTo, runDetailFrom, runSummaryFrom, stubFetch } from "@/test/api";
import { renderAt } from "@/test/render";

interface Served {
  fixture: TraceFixture;
  status: RunStatus;
  /** Highest seq the backend has recorded so far (for live runs). */
  upTo?: number;
}

function health(mode: Health["mode"]): Health {
  return { status: "ok", service: "swarmos", version: "0.3.0", mode, provider_mode: "auto", provider_kind: "demo", openai_configured: false, auth_required: false };
}

function serve(runs: Served[], { mode = "public_demo", eventsStatus }: { mode?: Health["mode"]; eventsStatus?: number } = {}) {
  return stubFetch((url) => {
    if (url.pathname === "/health") return json(health(mode));
    if (url.pathname === "/api/runs") {
      return json({ runs: runs.map((r) => runSummaryFrom(r.fixture, { status: r.status })), next_cursor: null });
    }
    for (const served of runs) {
      const runId = served.fixture.run.run_id;
      const record: Partial<RunRecord> = { status: served.status };
      if (url.pathname === `/api/runs/${runId}`) return json(runDetailFrom(served.fixture, record));
      if (url.pathname === `/api/runs/${runId}/events`) {
        if (eventsStatus) return json({ detail: "trace store unavailable" }, eventsStatus);
        const events = served.fixture.events.filter((e) => served.upTo === undefined || e.seq <= served.upTo);
        const after = url.searchParams.get("after_seq");
        return json(eventsPage(runId, events, after === null ? null : Number(after)));
      }
    }
    return undefined;
  });
}

const liveRun: Served = { fixture: fixtures.parallelOverlap, status: "running", upTo: 8 };
const doneRun: Served = { fixture: fixtures.reviewRevisionCompleted, status: "completed" };
const oldRun: Served = { fixture: fixtures.legacyPlannerRevision, status: "completed_with_findings" };

beforeEach(() => {
  useViewStore.setState({ runId: null, selection: null, followLive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live console", () => {
  it("opens the live run and shows exactly what is in flight", async () => {
    serve([doneRun, liveRun]);
    renderAt("/console");

    const now = await screen.findByRole("list", { name: "Running now" });
    const running = within(now).getAllByRole("listitem");
    expect(running).toHaveLength(2);
    expect(running.map((item) => item.textContent)).toEqual([
      expect.stringContaining("alpha"),
      expect.stringContaining("beta"),
    ]);
    expect(screen.getByText(/live · polling every second|receiving events/)).toBeInTheDocument();
    // gamma is planned but not dispatched: it is not in "Now".
    expect(within(now).queryByText("gamma")).not.toBeInTheDocument();
    expect(useViewStore.getState().runId).toBe(liveRun.fixture.run.run_id);
  });

  it("switches to a finished run and stops polling it", async () => {
    serve([liveRun, doneRun]);
    const { router } = renderAt("/console");
    await screen.findByRole("list", { name: "Running now" });

    const choice = screen.getAllByRole("button").find((button) => button.textContent?.includes(doneRun.fixture.run.goal!));
    await userEvent.click(choice!);

    expect(router.state.location.search).toBe(`?run=${doneRun.fixture.run.run_id}`);
    expect(await screen.findByText("polling stopped: run finished")).toBeInTheDocument();
    expect(screen.getByText("Nothing is running: the run has finished.")).toBeInTheDocument();
    const counters = screen.getByLabelText("Run counters");
    expect(within(counters).getByText("Revision rounds").nextSibling).toHaveTextContent("1");
  });

  it("is honest about traces recorded before lifecycle events", async () => {
    serve([oldRun]);
    renderAt(`/console?run=${oldRun.fixture.run.run_id}`);
    expect(await screen.findByText(/predates lifecycle events/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Running now" })).not.toBeInTheDocument();
  });

  it("follows a run to completion through cursor polling and the reducer", async () => {
    const run: Served = { ...liveRun, upTo: 8 };
    const fetchMock = serve([run]);
    renderAt(`/console?run=${run.fixture.run.run_id}`);
    await screen.findByRole("list", { name: "Running now" });

    // The backend records the rest of the run and marks it completed.
    run.upTo = undefined;
    run.status = "completed";
    expect(await screen.findByText("polling stopped: run finished", {}, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.getByText("Nothing is running: the run has finished.")).toBeInTheDocument();

    const polls = requestsTo(fetchMock, `/api/runs/${run.fixture.run.run_id}/events`);
    expect(polls[0].searchParams.get("after_seq")).toBeNull();
    expect(polls.slice(1).every((url) => Number(url.searchParams.get("after_seq")) >= 8)).toBe(true);
  }, 10_000);

  it("keeps the last state visible when the trace cannot be refreshed", async () => {
    serve([liveRun], { eventsStatus: 400 });
    renderAt(`/console?run=${liveRun.fixture.run.run_id}`);
    expect(await screen.findByText(/Connection problem \(trace store unavailable\)/)).toBeInTheDocument();
  });

  it("starts empty with a link to the catalog", async () => {
    serve([]);
    renderAt("/console");
    expect(await screen.findByRole("link", { name: "Start one" })).toHaveAttribute("href", "/runs/new");
  });
});

describe("legacy console", () => {
  it("is not offered, and explains itself, in the public demo", async () => {
    serve([], { mode: "public_demo" });
    renderAt("/legacy");
    expect(await screen.findByRole("heading", { name: "Local development only" })).toBeInTheDocument();
    expect(screen.queryAllByRole("link", { name: "Legacy" })).toHaveLength(0);
  });

  it("is linked in local mode", async () => {
    serve([], { mode: "local" });
    renderAt("/console");
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Legacy" }).length).toBeGreaterThan(0));
  });
});
