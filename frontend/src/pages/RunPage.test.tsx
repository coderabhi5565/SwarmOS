import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Health, RunRecord } from "@/api/types";
import { fixtures, type TraceFixture } from "@/domain/execution/fixtures";
import { eventsPage, json, runDetailFrom, stubFetch } from "@/test/api";
import { renderAt } from "@/test/render";

const health = (mode: Health["mode"]): Health => ({
  status: "ok",
  service: "swarmos",
  version: "0.3.0",
  mode,
  provider_mode: "auto",
  provider_kind: "demo",
  openai_configured: false,
  auth_required: false,
});

/** Serve one recorded run: its record, and its events by cursor. */
function serve(fixture: TraceFixture, { upTo, mode = "public_demo", record = {} }: { upTo?: number; mode?: Health["mode"]; record?: Partial<RunRecord> } = {}) {
  const runId = fixture.run.run_id;
  const events = fixture.events.filter((event) => upTo === undefined || event.seq <= upTo);
  return stubFetch((url) => {
    if (url.pathname === "/health") return json(health(mode));
    if (url.pathname === `/api/runs/${runId}`) return json(runDetailFrom(fixture, record));
    if (url.pathname === `/api/runs/${runId}/events`) {
      const after = url.searchParams.get("after_seq");
      return json(eventsPage(runId, events, after === null ? null : Number(after)));
    }
    return undefined;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("run detail", () => {
  it("renders a completed run from its normalised state", async () => {
    const fixture = fixtures.reviewRevisionCompleted;
    serve(fixture);
    renderAt(`/runs/${fixture.run.run_id}`);

    expect(await screen.findByRole("heading", { name: fixture.run.goal! })).toBeInTheDocument();
    const step = await screen.findByRole("listitem", { name: "Step draft_implementation" });
    expect(within(step).getByText("merged")).toBeInTheDocument();
    expect(within(step).getByText(/attempt 2 · 1 revision requested/)).toBeInTheDocument();

    const review = screen.getByRole("region", { name: "Review" });
    expect(within(review).getByText("changes requested")).toBeInTheDocument();
    expect(within(review).getByText("approved")).toBeInTheDocument();

    const verification = screen.getByRole("region", { name: "Verification" });
    expect(within(verification).getByText("passed")).toBeInTheDocument();
    expect(within(verification).getByText("3")).toBeInTheDocument();

    // Two coder calls and two reviewer calls; the verifier is never a model call.
    const calls = screen.getByRole("region", { name: "Model calls" });
    expect(within(calls).getAllByRole("row")).toHaveLength(5);
    expect(within(calls).queryByText("verifier")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Verification runner")).toHaveTextContent("Deterministic test runner, not a model");
  });

  it("draws the execution graph of a finished run, with nothing running", async () => {
    const fixture = fixtures.verificationRepair;
    serve(fixture);
    const { container } = renderAt(`/runs/${fixture.run.run_id}`);

    const graph = await screen.findByRole("region", { name: "Execution graph" });
    const nodes = within(graph).getByTestId("execution-graph-2d");
    expect(within(nodes).getByRole("group", { name: /^Coder step draft_implementation: succeeded, 2 attempts, repaired ×1/ })).toBeInTheDocument();
    expect(within(nodes).getByRole("group", { name: /^Verification runner \(deterministic\): succeeded, 2 runs/ })).toBeInTheDocument();
    expect(within(graph).queryByText("running")).not.toBeInTheDocument();
    expect(container.querySelector(".react-flow__edge.animated")).toBeNull();
    // The trace and the other panels stay on the page.
    expect(screen.getByRole("region", { name: "Verification" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Model calls" })).toBeInTheDocument();
  });

  it("shows dependencies and marks unreported usage as unknown", async () => {
    const fixture = fixtures.demoPipelineCompleted;
    serve(fixture);
    renderAt(`/runs/${fixture.run.run_id}`);

    const document = await screen.findByRole("listitem", { name: "Step document_change" });
    expect(within(document).getByText("inspect_tests, draft_implementation")).toBeInTheDocument();
    expect(screen.getAllByText("not reported").length).toBeGreaterThan(0);
    const budget = screen.getByRole("region", { name: "Budget and usage" });
    expect(within(budget).getByText("not reported by the provider")).toBeInTheDocument();
    expect(within(budget).getByText("not metered (no token pricing)")).toBeInTheDocument();
  });

  it("presents an old trace without inventing lifecycle activity", async () => {
    const fixture = fixtures.legacyPlannerRevision;
    serve(fixture);
    renderAt(`/runs/${fixture.run.run_id}`);

    expect(await screen.findByText(/predates lifecycle events/)).toBeInTheDocument();
    const calls = screen.getByRole("region", { name: "Model calls" });
    expect(within(calls).getAllByText("start not recorded")).toHaveLength(5);
    // That local model reported usage: real token counts are shown.
    expect(within(calls).queryByText("not reported")).not.toBeInTheDocument();
    // The old revision events (counter named "round") still give both verdicts.
    const review = screen.getByRole("region", { name: "Review" });
    expect(within(review).getAllByText("changes requested")).toHaveLength(2);
  });

  it("shows a live run's agents as they actually are", async () => {
    const fixture = fixtures.parallelOverlap;
    serve(fixture, { upTo: 8, record: { status: "running" } }); // both coders started
    renderAt(`/runs/${fixture.run.run_id}`);

    const coder = await screen.findByRole("listitem", { name: "Coder agent" });
    expect(await within(coder).findByText("2 running")).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Step gamma" })).toHaveTextContent("pending");
    expect(screen.getByText("Coding")).toBeInTheDocument(); // phase, no outcome yet
    expect(screen.getByRole("log")).toBeInTheDocument(); // the live trace region
  });

  it("marks an evidence-less rejection as an invalid review, not a failure or approval", async () => {
    const fixture = fixtures.reviewInvalid;
    serve(fixture);
    renderAt(`/runs/${fixture.run.run_id}`);
    const review = await screen.findByRole("region", { name: "Review" });
    expect(within(review).getByText("invalid review")).toBeInTheDocument();
    expect(within(review).queryByText("approved")).not.toBeInTheDocument();
  });

  it("offers cancellation only for a live run in local mode", async () => {
    const fixture = fixtures.parallelOverlap;
    serve(fixture, { upTo: 8, record: { status: "running" }, mode: "public_demo" });
    const publicView = renderAt(`/runs/${fixture.run.run_id}`);
    await screen.findByRole("listitem", { name: "Coder agent" });
    expect(screen.queryByRole("button", { name: /Cancel run/ })).not.toBeInTheDocument();
    publicView.unmount();

    vi.unstubAllGlobals();
    serve(fixture, { upTo: 8, record: { status: "running" }, mode: "local" });
    renderAt(`/runs/${fixture.run.run_id}`);
    expect(await screen.findByRole("button", { name: /Cancel run/ })).toBeInTheDocument();
  });

  it("reports a failed load instead of rendering an empty run", async () => {
    stubFetch((url) => (url.pathname === "/api/runs/run_x" ? json({ detail: "database unavailable" }, 400) : undefined));
    renderAt("/runs/run_x");
    expect(await screen.findByRole("alert")).toHaveTextContent("database unavailable");
  });
});
