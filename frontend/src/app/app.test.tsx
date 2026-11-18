import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DemoTasks, Health, RunList } from "@/api/types";
import { renderAt } from "@/test/render";

const health: Health = {
  status: "ok",
  service: "swarmos",
  version: "0.3.0",
  mode: "public_demo",
  provider_mode: "auto",
  provider_kind: "demo",
  openai_configured: false,
  auth_required: false,
};

const demoTasks: DemoTasks = {
  mode: "public_demo",
  tasks: [
    {
      id: "sample_parallel_pipeline",
      title: "Parallel pipeline",
      description: "Three steps in two dependency waves.",
      goal: "Implement normalize_tags and document it.",
      steps: [
        { id: "inspect_tests", title: "Inspect", depends_on: [] },
        { id: "draft_implementation", title: "Implement", depends_on: [] },
        { id: "document_change", title: "Document", depends_on: ["inspect_tests", "draft_implementation"] },
      ],
      waves: [["inspect_tests", "draft_implementation"], ["document_change"]],
      allowed_files: ["target.py", "docs/change-notes.md"],
      read_only_files: ["tests/test_target.py"],
      limits: {
        max_agent_calls: 10,
        max_budget_usd: 0.25,
        max_wall_seconds: 180,
        max_retries: 1,
        max_revisions: 1,
        max_escalations: 0,
        parallel_coding: true,
      },
    },
  ],
};

const runs: RunList = {
  next_cursor: null,
  runs: [
    {
      run_id: "run_abc123",
      created_at: "2026-11-01T10:00:00+00:00",
      updated_at: "2026-11-01T10:01:00+00:00",
      goal: "Implement normalize_tags so the tests pass",
      status: "review_invalid",
      provider: "demo",
      provider_kind: "demo",
      model_policy: "config",
      models_by_role: {},
      limits: demoTasks.tasks[0].limits,
      error: null,
      cost_usd: 0,
      monetary_enforced: false,
      usage_available: false,
      agent_calls: 2,
      escalations: 0,
      revisions: 0,
      duration_ms: 1200,
      changed_files: ["target.py"],
      plan_step_count: 1,
      review_verdict: "request_changes",
      verification_passed: true,
      verification_diagnostic: true,
    },
  ],
};

/** Stub fetch by path: each value is a body, or "fail" to reject like a sleeping server. */
function stubApi(responses: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const body = responses[path];
      if (body === "fail") throw new TypeError("Failed to fetch");
      if (body === undefined) return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("overview", () => {
  it("shows the real catalog, history and backend mode", async () => {
    stubApi({ "/health": health, "/api/demo-tasks": demoTasks, "/api/runs": runs });
    renderAt("/app");

    expect(await screen.findByText("Parallel pipeline")).toBeInTheDocument();
    expect(screen.getByText(/3 steps · 2 waves · parallel/)).toBeInTheDocument();

    const run = await screen.findByRole("link", { name: /Implement normalize_tags so the tests pass/ });
    expect(run).toHaveAttribute("href", "/runs/run_abc123");
    expect(within(run).getByText("invalid review")).toBeInTheDocument();

    expect(await screen.findAllByText(/public demo · demo fixture/)).not.toHaveLength(0);
  });

  it("reports a sleeping backend as waking, not failed", async () => {
    stubApi({ "/health": "fail", "/api/demo-tasks": demoTasks, "/api/runs": runs });
    renderAt("/app");
    expect((await screen.findAllByText("waking server…")).length).toBeGreaterThan(0);
    expect(screen.queryByText("API unreachable")).not.toBeInTheDocument();
  });

  it("shows API errors instead of empty sections", async () => {
    stubApi({ "/health": health, "/api/runs": runs }); // the catalog 404s
    renderAt("/app");
    expect(await screen.findByRole("alert")).toHaveTextContent("not found");
  });
});

describe("routing", () => {
  it("renders a not-found page for unknown paths inside the shell", async () => {
    stubApi({ "/health": health });
    renderAt("/no/such/page");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getAllByRole("navigation", { name: "Main" }).length).toBeGreaterThan(0);
  });

  it("deep-links to a run that does not exist", async () => {
    stubApi({ "/health": health });
    renderAt("/runs/run_missing");
    expect(await screen.findByRole("heading", { name: "Run not found" })).toBeInTheDocument();
  });
});

describe("workspace routes", () => {
  it("leads from / to the workspace overview at /app", async () => {
    stubApi({ "/health": health, "/api/demo-tasks": demoTasks, "/api/runs": runs });
    const { router } = renderAt("/");
    expect(await screen.findByText("Parallel pipeline")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/app");
  });

  it("links the navigation to every workspace page", async () => {
    stubApi({ "/health": { ...health, mode: "local" } });
    renderAt("/app");
    const nav = screen.getAllByRole("navigation", { name: "Main" })[0];
    await within(nav).findByRole("link", { name: "Legacy" }); // local mode only
    const hrefs = within(nav).getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(["/app", "/runs/new", "/console", "/history", "/benchmarks", "/legacy"]);
    expect(screen.getByRole("link", { name: "SwarmOS" })).toHaveAttribute("href", "/");
  });

  it.each(["/app", "/runs/new", "/console", "/history", "/benchmarks"])("%s renders inside the shell", async (path) => {
    stubApi({ "/health": health, "/api/demo-tasks": demoTasks, "/api/runs": runs });
    renderAt(path);
    expect((await screen.findAllByRole("navigation", { name: "Main" })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "Page not found" })).not.toBeInTheDocument();
  });
});
