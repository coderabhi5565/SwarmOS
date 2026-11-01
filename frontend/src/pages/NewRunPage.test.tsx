import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DemoTasks, Health } from "@/api/types";
import { fixtures } from "@/domain/execution/fixtures";
import { json, requestsTo, runDetailFrom, stubFetch, type Route } from "@/test/api";
import { renderAt } from "@/test/render";

const limits = { max_agent_calls: 6, max_budget_usd: 0.25, max_wall_seconds: 120, max_retries: 0, max_revisions: 1, max_escalations: 0, parallel_coding: true };

const catalog: DemoTasks = {
  mode: "public_demo",
  tasks: [
    {
      id: "sample_tag_normalization",
      title: "Fix one function",
      description: "One coding step.",
      goal: "Implement normalize_tags in target.py so the three tests in tests/test_target.py pass.",
      steps: [{ id: "draft_implementation", title: "Implement", depends_on: [] }],
      waves: [["draft_implementation"]],
      allowed_files: ["target.py"],
      read_only_files: ["tests/test_target.py"],
      limits,
    },
    {
      id: "sample_parallel_pipeline",
      title: "Parallel pipeline",
      description: "Three steps in two dependency waves.",
      goal: "Implement normalize_tags and document the change.",
      steps: [
        { id: "inspect_tests", title: "Inspect", depends_on: [] },
        { id: "draft_implementation", title: "Implement", depends_on: [] },
        { id: "document_change", title: "Document", depends_on: ["inspect_tests", "draft_implementation"] },
      ],
      waves: [["inspect_tests", "draft_implementation"], ["document_change"]],
      allowed_files: ["target.py", "docs/change-notes.md"],
      read_only_files: ["tests/test_target.py"],
      limits: { ...limits, max_agent_calls: 10, max_wall_seconds: 180 },
    },
  ],
};

const health: Health = { status: "ok", service: "swarmos", version: "0.3.0", mode: "public_demo", provider_mode: "auto", provider_kind: "demo", openai_configured: false, auth_required: false };

function serve(createRun: Route = () => undefined) {
  return stubFetch((url, init) => {
    if (url.pathname === "/health") return json(health);
    if (url.pathname === "/api/demo-tasks") return json(catalog);
    if (url.pathname === "/api/runs" && init?.method === "POST") return createRun(url, init);
    return undefined;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("new run", () => {
  it("lists the catalog with its plan structure and offers nothing free-form", async () => {
    serve();
    renderAt("/runs/new");
    expect(await screen.findByRole("radio", { name: /Parallel pipeline/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Fix one function/ })).toBeInTheDocument();
    expect(screen.getByText("← after inspect_tests, draft_implementation")).toBeInTheDocument();

    // Public demo restrictions: no goal box, no files, no provider choice.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole("link", { name: "legacy console" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start run" })).toBeDisabled();
  });

  it("starts the selected task and opens its run", async () => {
    const created = runDetailFrom(fixtures.demoPipelineCompleted, { status: "queued" });
    const fetchMock = serve(() => json(created, 202));
    const { router } = renderAt("/runs/new");

    await userEvent.click(await screen.findByRole("radio", { name: /Parallel pipeline/ }));
    await userEvent.click(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/runs/${created.run.run_id}`));
    const [post] = requestsTo(fetchMock, "/api/runs");
    const body = JSON.parse(String(fetchMock.mock.calls.find(([input]) => String(input).endsWith("/api/runs"))?.[1]?.body));
    expect(post).toBeDefined();
    expect(body).toEqual({ goal: catalog.tasks[1].goal, demo_task: "sample_parallel_pipeline" });
  });

  it.each([
    [429, { "Retry-After": "120" }, "run limit reached for this client; retry in 120s", "Busy right now. Try again in 2 min."],
    [429, { "Retry-After": "30" }, "2 run(s) already in flight; the limit is 2", "Busy right now. Try again in 30 s."],
    [403, {}, "the public demo runs catalog tasks only", "Not available in the public demo."],
  ])("explains a %i answer", async (status, headers, detail, message) => {
    serve(() => json({ detail }, status, headers));
    renderAt("/runs/new");
    await userEvent.click(await screen.findByRole("radio", { name: /Fix one function/ }));
    await userEvent.click(screen.getByRole("button", { name: "Start run" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveTextContent(detail);
    expect(screen.getByRole("button", { name: "Start run" })).toBeEnabled();
  });

  it("explains an unreachable server as possibly waking", async () => {
    serve(() => {
      throw new TypeError("Failed to fetch");
    });
    renderAt("/runs/new");
    await userEvent.click(await screen.findByRole("radio", { name: /Fix one function/ }));
    await userEvent.click(screen.getByRole("button", { name: "Start run" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/can take up to a minute to wake/);
  });

  it("reports a catalog that failed to load", async () => {
    stubFetch((url) => (url.pathname === "/api/demo-tasks" ? json({ detail: "catalog unavailable" }, 400) : undefined));
    renderAt("/runs/new");
    expect(await screen.findByRole("alert")).toHaveTextContent("catalog unavailable");
  });
});
