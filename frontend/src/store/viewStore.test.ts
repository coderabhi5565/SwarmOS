import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultViewMode, useViewStore } from "@/store/viewStore";

const initial = useViewStore.getState();

beforeEach(() => {
  useViewStore.setState(initial, true);
});

describe("view store", () => {
  it("selects agents and steps and clears the selection", () => {
    const { select, clearSelection } = useViewStore.getState();
    select({ kind: "agent", role: "reviewer" });
    expect(useViewStore.getState().selection).toEqual({ kind: "agent", role: "reviewer" });
    select({ kind: "step", stepId: "draft_implementation" });
    expect(useViewStore.getState().selection).toEqual({ kind: "step", stepId: "draft_implementation" });
    clearSelection();
    expect(useViewStore.getState().selection).toBeNull();
  });

  it("scopes the selection to a run", () => {
    const { focusRun, select, setFollowLive } = useViewStore.getState();
    focusRun("run_a");
    select({ kind: "step", stepId: "alpha" });
    setFollowLive(false);

    focusRun("run_a"); // same run: nothing resets
    expect(useViewStore.getState().selection).toEqual({ kind: "step", stepId: "alpha" });

    focusRun("run_b"); // another run starts fresh
    expect(useViewStore.getState()).toMatchObject({ runId: "run_b", selection: null, followLive: true });
  });

  it("switches between 2D and 3D", () => {
    useViewStore.getState().setViewMode("2d");
    expect(useViewStore.getState().viewMode).toBe("2d");
  });
});

describe("defaultViewMode", () => {
  it.each([
    [true, "2d"],
    [false, "3d"],
  ])("prefers-reduced-motion=%s gives %s", (reduce, expected) => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce") }));
    expect(defaultViewMode()).toBe(expected);
    vi.unstubAllGlobals();
  });
});
