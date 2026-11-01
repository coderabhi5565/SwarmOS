import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, type ExecutionState } from "@/domain/execution";
import { fixtures } from "@/domain/execution/fixtures";
import { useViewStore } from "@/store/viewStore";
import { ExecutionView } from "./ExecutionView";
import { resetWebglCheck } from "./webgl";

const scene = vi.hoisted(() => ({ loaded: false }));
vi.mock("./ExecutionScene3D", () => {
  scene.loaded = true;
  return { default: () => <div data-testid="scene-stand-in" /> };
});

type Name = keyof typeof fixtures;
const final = (name: Name) => replay(fixtures[name].events, { seed: fixtures[name].run, settle: true });
const initial = useViewStore.getState();

beforeEach(() => {
  useViewStore.setState(initial, true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({}) as never);
  resetWebglCheck();
});
afterEach(() => resetWebglCheck());

const details = () => screen.getByRole("complementary", { name: "Node details" });
const modeButton = (name: string) => within(screen.getByRole("group", { name: "View" })).getByRole("button", { name });

describe("ExecutionView", () => {
  it("starts in 2D without loading the 3D scene", () => {
    render(<ExecutionView state={final("parallelOverlap")} live={false} />);
    expect(screen.getByTestId("execution-graph-2d")).toBeInTheDocument();
    expect(modeButton("2D graph")).toHaveAttribute("aria-pressed", "true");
    // First test in the file: nothing has imported the scene module.
    expect(scene.loaded).toBe(false);
  });

  it("switches between 2D and 3D keeping the selection and the details", async () => {
    render(<ExecutionView state={final("retryEscalation")} live={false} />);
    fireEvent.click(within(screen.getByTestId("execution-graph-2d")).getByRole("group", { name: /^Coder step alpha/ }));
    expect(within(details()).getByRole("heading", { name: "alpha" })).toBeInTheDocument();

    fireEvent.click(modeButton("3D scene"));
    expect(await screen.findByTestId("scene-stand-in")).toBeInTheDocument();
    expect(scene.loaded).toBe(true);
    expect(screen.queryByTestId("execution-graph-2d")).not.toBeInTheDocument();
    expect(useViewStore.getState().selection).toEqual({ kind: "step", stepId: "alpha" });
    expect(within(details()).getByRole("heading", { name: "alpha" })).toBeInTheDocument();

    fireEvent.click(modeButton("2D graph"));
    expect(screen.getByTestId("execution-graph-2d")).toBeInTheDocument();
    expect(within(details()).getByRole("heading", { name: "alpha" })).toBeInTheDocument();
    expect(useViewStore.getState().viewMode).toBe("2d");
  });

  it("shares follow-live, and offers it only while the run is live", () => {
    const fixture = fixtures.parallelOverlap;
    const live = replay(fixture.events.slice(0, 8), { seed: fixture.run });
    const { rerender } = render(<ExecutionView state={live} live />);
    fireEvent.click(screen.getByRole("button", { name: "Following live" }));
    expect(useViewStore.getState().followLive).toBe(false);
    expect(screen.getByRole("button", { name: "Follow live" })).toHaveAttribute("aria-pressed", "false");
    rerender(<ExecutionView state={final("parallelOverlap")} live={false} />);
    expect(screen.queryByRole("button", { name: /Follow/ })).not.toBeInTheDocument();
  });

  it("says what an old trace cannot show", () => {
    render(<ExecutionView state={final("legacyFalseBlocker")} live={false} />);
    expect(screen.getByText(/predates start events: results are shown, but not when work was running/)).toBeInTheDocument();
  });

  it("says when dependencies were not recorded", () => {
    const state = final("legacyLimitAtReview");
    const unknown: ExecutionState = { ...state, plan: { ...state.plan!, dependenciesKnown: false } };
    render(<ExecutionView state={unknown} live={false} />);
    expect(screen.getByText(/Step dependencies were not recorded/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Edge legend" })).toBeInTheDocument();
  });
});
