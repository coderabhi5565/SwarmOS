import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createReplay, replay, type ExecutionState } from "@/domain/execution";
import { fixtures } from "@/domain/execution/fixtures";
import { buildVizModel } from "@/domain/visualization";
import { useViewStore } from "@/store/viewStore";
import { ExecutionGraph2D } from "./ExecutionGraph2D";
import { NodeDetails } from "./NodeDetails";
import { useVizModel } from "./useVizModel";

type Name = keyof typeof fixtures;
const final = (name: Name) => replay(fixtures[name].events, { seed: fixtures[name].run, settle: true });

function View({ state, live = false }: { state: ExecutionState; live?: boolean }) {
  const model = useVizModel(state);
  return (
    <div style={{ width: 800, height: 480 }}>
      <ExecutionGraph2D model={model} live={live} />
      <NodeDetails state={state} model={model} />
    </div>
  );
}

const initial = useViewStore.getState();
beforeEach(() => useViewStore.setState(initial, true));

const graphNode = (name: RegExp) => within(screen.getByTestId("execution-graph-2d")).getByRole("group", { name });

describe("ExecutionGraph2D", () => {
  it("draws every actor with an accessible description", () => {
    render(<View state={final("parallelOverlap")} />);
    expect(graphNode(/^Planner agent: succeeded/)).toBeInTheDocument();
    expect(graphNode(/^Coder step alpha: succeeded, wave 1/)).toBeInTheDocument();
    expect(graphNode(/^Coder step beta: succeeded, wave 1/)).toBeInTheDocument();
    expect(graphNode(/^Coder step gamma: succeeded, wave 2/)).toBeInTheDocument();
    expect(graphNode(/^Reviewer agent: succeeded/)).toBeInTheDocument();
    expect(graphNode(/^Verification runner \(deterministic\): succeeded/)).toBeInTheDocument();
    expect(screen.getByText("deterministic runner")).toBeInTheDocument();
  });

  it("shows retries, revisions, repairs and the escalated tier", () => {
    const { unmount } = render(<View state={final("retryEscalation")} />);
    expect(graphNode(/^Coder step alpha: succeeded, 3 attempts, retried, strong tier/)).toBeInTheDocument();
    unmount();
    const second = render(<View state={final("legacyPlannerRevision")} />);
    expect(graphNode(/^Coder step normalize_tags: .*revised ×2/)).toBeInTheDocument();
    expect(screen.getByText("revise ×2")).toBeInTheDocument();
    second.unmount();
    render(<View state={final("verificationRepair")} />);
    expect(graphNode(/^Coder step draft_implementation: .*repaired ×1/)).toBeInTheDocument();
    expect(screen.getByText("repair")).toBeInTheDocument();
  });

  it("says which actors a stopped run never reached", () => {
    render(<View state={final("callLimitExhausted")} />);
    expect(graphNode(/^Reviewer agent: not reached/)).toBeInTheDocument();
    expect(graphNode(/^Verification runner \(deterministic\): not reached/)).toBeInTheDocument();
  });

  it("renders a finished run with nothing running or animated", () => {
    const { container } = render(<View state={final("demoPipelineCompleted")} />);
    expect(screen.queryByText("running")).not.toBeInTheDocument();
    expect(container.querySelector(".react-flow__edge.animated")).toBeNull();
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });

  it("marks running work, and only that, while a run is live", () => {
    const fixture = fixtures.parallelOverlap;
    const state = replay(fixture.events.slice(0, 8), { seed: fixture.run });
    const { container } = render(<View state={state} live />);
    expect(graphNode(/^Coder step alpha: running/)).toBeInTheDocument();
    expect(graphNode(/^Coder step beta: running/)).toBeInTheDocument();
    expect(graphNode(/^Coder step gamma: pending/)).toBeInTheDocument();
    expect(container.querySelectorAll(".react-flow__edge.animated")).toHaveLength(2);
  });

  it("selects a node into the shared store and shows its details", () => {
    render(<View state={final("retryEscalation")} />);
    fireEvent.click(graphNode(/^Coder step alpha/));
    expect(useViewStore.getState().selection).toEqual({ kind: "step", stepId: "alpha" });
    const details = screen.getByRole("complementary", { name: "Node details" });
    expect(within(details).getByRole("heading", { name: "alpha" })).toBeInTheDocument();
    expect(within(within(details).getByRole("list", { name: "Model calls" })).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(within(details).getByRole("button", { name: "Close details" }));
    expect(useViewStore.getState().selection).toBeNull();
  });

  it("shows the runner's test runs, not model calls", () => {
    useViewStore.getState().select({ kind: "runner" });
    render(<View state={final("verificationRepair")} />);
    const details = screen.getByRole("complementary", { name: "Node details" });
    expect(within(details).getByText(/No model is involved/)).toBeInTheDocument();
    expect(within(within(details).getByRole("list", { name: "Verification runs" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("says when a trace does not record start events", () => {
    useViewStore.getState().select({ kind: "step", stepId: "normalize_tags" });
    render(<View state={final("legacyPlannerRevision")} />);
    expect(screen.getByText(/when this work was running is unknown/)).toBeInTheDocument();
  });

  it("shows unknown dependencies as unknown", () => {
    const state = final("legacyLimitAtReview");
    const plan = state.plan!;
    const unknown: ExecutionState = {
      ...state,
      plan: {
        ...plan,
        dependenciesKnown: false,
        steps: Object.fromEntries(Object.entries(plan.steps).map(([id, step]) => [id, { ...step, dependsOn: null }])),
      },
    };
    useViewStore.getState().select({ kind: "step", stepId: "update_tests" });
    const { container } = render(<View state={unknown} />);
    expect(within(screen.getByRole("complementary", { name: "Node details" })).getByText("not recorded")).toBeInTheDocument();
    expect(container.querySelector('[data-id^="dependency:"]')).toBeNull();
  });

  it("follows the reducer: new events update the same nodes in place", () => {
    const fixture = fixtures.demoPipelineCompleted;
    const run = createReplay(fixture.events, fixture.run);
    const { rerender } = render(<View state={run.stateAtIndex(3)} live />);
    const node = graphNode(/^Coder step inspect_tests: running/);
    rerender(<View state={run.stateAtIndex(4)} live />);
    expect(graphNode(/^Coder step inspect_tests: awaiting merge/)).toBe(node);
    expect(buildVizModel(run.final()).nodes).toHaveLength(6);
  });
});
