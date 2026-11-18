import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Health } from "@/api/types";
import { WALKTHROUGH } from "@/components/landing/traceWalkthrough";
import { fixtures } from "@/domain/execution/fixtures";
import { json, stubFetch } from "@/test/api";
import { renderAt } from "@/test/render";

const publicHealth: Health = {
  status: "ok",
  service: "swarmos",
  version: "0.3.0",
  mode: "public_demo",
  provider_mode: "demo",
  provider_kind: "demo",
  openai_configured: false,
  auth_required: false,
};

function serve(health: Health | "down" = publicHealth) {
  return stubFetch((url) => {
    if (url.pathname === "/health") return health === "down" ? json({ detail: "starting" }, 503) : json(health);
    return undefined;
  });
}

const hero = () => screen.getByRole("region", { name: /Agents that plan, code, review and verify/ });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("landing page", () => {
  it("is the front page, inside the shell, with its three ways in", async () => {
    serve();
    renderAt("/");
    expect(await screen.findByRole("heading", { level: 1, name: /Every decision on the record/ })).toBeInTheDocument();
    expect(screen.getAllByRole("navigation", { name: "Main" }).length).toBeGreaterThan(0);
    expect(within(hero()).getByRole("link", { name: /Launch Live Demo/ })).toHaveAttribute("href", "/runs/new");
    expect(within(hero()).getByRole("link", { name: "Inspect Benchmarks" })).toHaveAttribute("href", "/benchmarks");
    expect(within(hero()).getByRole("link", { name: "Open Workspace" })).toHaveAttribute("href", "/app");
  });

  it("opens the live demo from the primary call to action", async () => {
    serve();
    const { router } = renderAt("/");
    await userEvent.click(await screen.findByRole("link", { name: /Launch Live Demo/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/runs/new"));
  });

  it.each([
    ["the public demo", publicHealth, "public demo · demo fixture"],
    ["a local server with a local model", { ...publicHealth, mode: "local", provider_mode: "auto", provider_kind: "local" } as Health, "local · local model"],
  ])("shows the backend's live mode for %s", async (_name, health, label) => {
    serve(health);
    renderAt("/");
    await screen.findByRole("heading", { level: 1 });
    expect(await within(hero()).findByText(label)).toBeInTheDocument();
  });

  it("shows a sleeping backend as waking, not as a mode", async () => {
    serve("down");
    renderAt("/");
    await screen.findByRole("heading", { level: 1 });
    expect(await within(hero()).findByText("waking server…")).toBeInTheDocument();
    expect(within(hero()).queryByText(/public demo ·/)).not.toBeInTheDocument();
  });

  it("draws the pipeline as a 2D diagram where there is no WebGL2 (as in jsdom)", async () => {
    serve();
    const { container } = renderAt("/");
    await screen.findByRole("heading", { level: 1 });
    expect(within(hero()).getByTestId("hero-pipeline-2d")).toBeInTheDocument();
    expect(container.querySelector("[data-hero]")).toHaveAttribute("data-hero", "no-webgl2");
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("describes the four engineering decisions and the modules behind them", async () => {
    serve();
    renderAt("/");
    const architecture = await screen.findByRole("region", { name: "Four decisions that shape every run" });
    const titles = within(architecture).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(titles).toEqual([
      "LangGraph parallel waves",
      "Reviewer evidence guard",
      "Monotonic span observability",
      "Fail-closed public sandbox",
    ]);
    expect(architecture).toHaveTextContent("review_invalid");
    expect(architecture).toHaveTextContent("perf_counter_ns");
    expect(architecture).toHaveTextContent("app/review_evidence.py");
    expect(architecture).toHaveTextContent("app/runtime/code_policy.py · app/runtime/sandbox_launcher.py · app/redaction.py");
  });

  it("walks through the trace by tab, with the keyboard too", async () => {
    serve();
    renderAt("/");
    const tabs = await screen.findByRole("tablist", { name: "Stages of a run" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["1Plan", "2Parallel wave", "3Review", "4Verify"]);
    expect(screen.getByRole("tabpanel")).toHaveTextContent("routing_decision");
    expect(screen.getByRole("tabpanel")).toHaveTextContent('"decision": "plan_seeded"');

    await userEvent.click(within(tabs).getByRole("tab", { name: /Verify/ }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("seq 16");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Verification passed");
    expect(screen.getByRole("tabpanel")).toHaveTextContent('"tests_passed": 3');

    within(tabs).getByRole("tab", { name: /Plan/ }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(within(tabs).getByRole("tab", { name: /Parallel wave/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Merged 1 file change(s) into the workspace");
  });

  it("says plainly what the public deployment runs", async () => {
    serve();
    renderAt("/");
    const note = await screen.findByRole("note", { name: "About this deployment" });
    expect(note).toHaveTextContent("deterministic scripted provider");
    expect(note).toHaveTextContent("Curated catalog tasks only");
    expect(note).toHaveTextContent("Ephemeral SQLite storage");
    expect(note).toHaveTextContent("₹0/month");
  });

  it("only reads the backend's health", async () => {
    const mock = serve();
    renderAt("/");
    await screen.findAllByText("public demo · demo fixture");
    const calls = mock.mock.calls.map(([input, init]) => [new URL(String(input), "http://localhost").pathname, init?.method ?? "GET"]);
    expect(new Set(calls.map((call) => call.join(" ")))).toEqual(new Set(["/health GET"]));
  });
});

describe("the trace walkthrough", () => {
  const recorded = fixtures.demoPipelineCompleted.events;

  it("shows only events the backend recorded, field for field", () => {
    const excerpts = WALKTHROUGH.flatMap((step) => step.events);
    expect(excerpts.map((event) => event.seq)).toEqual([2, 3, 5, 8, 14, 16]);
    for (const excerpt of excerpts) {
      const event = recorded.find((candidate) => candidate.seq === excerpt.seq);
      expect(event, `seq ${excerpt.seq}`).toBeDefined();
      expect(event?.kind).toBe(excerpt.kind);
      expect(event?.message).toBe(excerpt.message);
      expect(event?.payload).toMatchObject(excerpt.payload);
    }
  });

  it("uses the backend's event kinds, in the order a run records them", () => {
    const kinds = new Set<string>(recorded.map((event) => event.kind));
    const shown = WALKTHROUGH.flatMap((step) => step.events.map((event) => event.kind));
    for (const kind of shown) expect(kinds.has(kind)).toBe(true);
    expect([...new Set(shown)]).toEqual(["routing_decision", "agent_invocation", "verification"]);
  });
});
