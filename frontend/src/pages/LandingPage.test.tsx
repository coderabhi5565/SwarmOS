import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Health } from "@/api/types";
import { WALKTHROUGH } from "@/components/landing/traceWalkthrough";
import { fixtures } from "@/domain/execution/fixtures";
import { json, stubFetch } from "@/test/api";
import { renderAt } from "@/test/render";
import { REPLAY_STEP_MS } from "./LandingPage";

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

const hero = () => screen.getByRole("region", { name: "Deterministic Multi-Agent Orchestration." });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("landing page", () => {
  it("is the front page, inside the shell, with a short headline and two ways in", async () => {
    serve();
    renderAt("/");
    const heading = await screen.findByRole("heading", { level: 1, name: "Deterministic Multi-Agent Orchestration." });
    expect(heading.textContent?.trim().split(/\s+/)).toHaveLength(3);
    expect(hero()).toHaveTextContent("Parallel LangGraph waves, evidence-guarded reviews, and nanosecond span traces.");
    expect(screen.getAllByRole("navigation", { name: "Main" }).length).toBeGreaterThan(0);
    expect(within(hero()).getByRole("link", { name: /Launch Live Demo/ })).toHaveAttribute("href", "/runs/new");
    expect(within(hero()).getByRole("link", { name: "Benchmarks" })).toHaveAttribute("href", "/benchmarks");
    // The workspace stays one click away, in the navigation.
    expect(screen.getAllByRole("link", { name: "Overview" })[0]).toHaveAttribute("href", "/app");
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

describe("landing page interactions", () => {
  const tab = (name: RegExp) => within(screen.getByRole("tablist", { name: "Stages of a run" })).getByRole("tab", { name });
  const stageState = (id: string) => screen.getByTestId("beam-diagram").querySelector(`[data-stage="${id}"]`)?.getAttribute("data-state");

  it("names the pipeline in a ticker that rests when there is no 3D cycle to follow", async () => {
    serve();
    renderAt("/");
    await screen.findByRole("heading", { level: 1 });
    const ticker = within(hero()).getByRole("list", { name: "Pipeline" });
    expect(within(ticker).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "PLANNER",
      "→3× CODER WAVE",
      "→EVIDENCE GUARD",
      "→PYTEST",
    ]);
    // jsdom has no WebGL2: the 2D diagram plays no cycle, so nothing is lit.
    expect(ticker.querySelector("[aria-current]")).toBeNull();
  });

  it("puts each engineering decision on a spotlight card that follows the pointer", async () => {
    serve();
    renderAt("/");
    const architecture = await screen.findByRole("region", { name: "Four decisions that shape every run" });
    const cards = within(architecture).getAllByRole("article");
    expect(cards).toHaveLength(4);
    expect(cards.every((card) => card.hasAttribute("data-spotlight"))).toBe(true);
    fireEvent.pointerMove(cards[1], { clientX: 42, clientY: 17 });
    expect(cards[1].style.getPropertyValue("--mouse-x")).toBe("42px");
    expect(cards[0].style.getPropertyValue("--mouse-x")).toBe(""); // only the card under the pointer
    expect(within(cards[1]).getByRole("heading", { level: 3 })).toHaveTextContent("Reviewer evidence guard");
  });

  it("leaves the cards still under reduced motion", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    serve();
    renderAt("/");
    const architecture = await screen.findByRole("region", { name: "Four decisions that shape every run" });
    const [card] = within(architecture).getAllByRole("article");
    fireEvent.pointerMove(card, { clientX: 42, clientY: 17 });
    expect(card.style.getPropertyValue("--mouse-x")).toBe("");
    // The page is all there without motion: content, tabs and calls to action.
    expect(within(card).getByRole("heading", { level: 3 })).toHaveTextContent("LangGraph parallel waves");
    expect(within(hero()).getByRole("link", { name: /Launch Live Demo/ })).toHaveAttribute("href", "/runs/new");
  });

  it("moves the beam diagram with the tab in view", async () => {
    serve();
    renderAt("/");
    await screen.findByRole("tablist", { name: "Stages of a run" });
    expect(stageState("plan")).toBe("active");
    await userEvent.click(tab(/Review/));
    expect(["plan", "wave", "review", "verify"].map(stageState)).toEqual(["done", "done", "active", "idle"]);
    expect(screen.getByTestId("beam-diagram").querySelector('[data-beam="review"]')).toHaveClass("landing-beam");
  });

  it("replays the execution cycle stage by stage, then rests on the last", async () => {
    serve();
    renderAt("/");
    await screen.findByRole("tablist", { name: "Stages of a run" });
    await userEvent.click(tab(/Verify/)); // start somewhere else: a replay begins at the plan
    const status = () => screen.getByRole("status", { name: "Replay progress" });

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Replay Execution Cycle" }));
      expect(tab(/Plan/)).toHaveAttribute("aria-selected", "true");
      expect(status()).toHaveTextContent("Replaying: step 1 of 4");
      const expected: [RegExp, string][] = [
        [/Parallel wave/, "wave"],
        [/Review/, "review"],
        [/Verify/, "verify"],
      ];
      for (const [index, [name, id]] of expected.entries()) {
        act(() => vi.advanceTimersByTime(REPLAY_STEP_MS));
        expect(tab(name)).toHaveAttribute("aria-selected", "true");
        expect(stageState(id)).toBe("active");
        expect(status()).toHaveTextContent(`Replaying: step ${index + 2} of 4`);
      }
      expect(screen.getByRole("tabpanel")).toHaveTextContent("Verification passed");
      act(() => vi.advanceTimersByTime(REPLAY_STEP_MS));
      expect(status()).toHaveTextContent(/^$/); // finished
      act(() => vi.advanceTimersByTime(REPLAY_STEP_MS * 3));
      expect(tab(/Verify/)).toHaveAttribute("aria-selected", "true"); // it does not loop
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a replay when a stage is chosen by hand", async () => {
    serve();
    renderAt("/");
    await screen.findByRole("tablist", { name: "Stages of a run" });
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Replay Execution Cycle" }));
      act(() => vi.advanceTimersByTime(REPLAY_STEP_MS));
      expect(tab(/Parallel wave/)).toHaveAttribute("aria-selected", "true");
      fireEvent.mouseDown(tab(/Plan/)); // Radix selects a tab on mouse down
      expect(tab(/Plan/)).toHaveAttribute("aria-selected", "true");
      act(() => vi.advanceTimersByTime(REPLAY_STEP_MS * 4));
      expect(tab(/Plan/)).toHaveAttribute("aria-selected", "true"); // the replay no longer advances
      expect(screen.queryByText(/Replaying: step/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaches the replay control and the calls to action from the keyboard", async () => {
    serve();
    renderAt("/");
    await screen.findByRole("heading", { level: 1 });
    const replay = screen.getByRole("button", { name: "Replay Execution Cycle" });
    replay.focus();
    expect(replay).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText("Replaying: step 1 of 4")).toBeInTheDocument();
    const cta = within(hero()).getByRole("link", { name: /Launch Live Demo/ });
    cta.focus();
    expect(cta).toHaveFocus();
  });
});
