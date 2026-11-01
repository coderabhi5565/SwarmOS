import { beforeEach, describe, expect, it } from "vitest";
import { selectionFromNodeId, selectionNodeId, useViewStore } from "@/store/viewStore";

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

  it("selects the verification runner", () => {
    useViewStore.getState().select({ kind: "runner" });
    expect(useViewStore.getState().selection).toEqual({ kind: "runner" });
  });

  it("keeps the state object when the same entity is selected again", () => {
    const { select } = useViewStore.getState();
    select({ kind: "step", stepId: "alpha" });
    const before = useViewStore.getState();
    select({ kind: "step", stepId: "alpha" });
    expect(useViewStore.getState()).toBe(before);
  });

  it("starts in 2D, the view that needs no WebGL, and switches to 3D", () => {
    expect(useViewStore.getState().viewMode).toBe("2d");
    useViewStore.getState().setViewMode("3d");
    expect(useViewStore.getState().viewMode).toBe("3d");
  });

  it("keeps the selection and follow-live when the view mode changes", () => {
    const { focusRun, select, setFollowLive, setViewMode } = useViewStore.getState();
    focusRun("run_a");
    select({ kind: "runner" });
    setFollowLive(false);
    setViewMode("3d");
    setViewMode("2d");
    expect(useViewStore.getState()).toMatchObject({ runId: "run_a", selection: { kind: "runner" }, followLive: false });
  });
});

describe("selection node ids", () => {
  it.each([
    [{ kind: "agent", role: "planner" } as const, "agent:planner"],
    [{ kind: "agent", role: "reviewer" } as const, "agent:reviewer"],
    [{ kind: "step", stepId: "draft_implementation" } as const, "step:draft_implementation"],
    [{ kind: "runner" } as const, "runner:verifier"],
  ])("round-trips %o as %s", (selection, id) => {
    expect(selectionNodeId(selection)).toBe(id);
    expect(selectionFromNodeId(id)).toEqual(selection);
  });

  it("maps nothing to nothing", () => {
    expect(selectionNodeId(null)).toBeNull();
    expect(selectionFromNodeId("step:")).toBeNull();
    expect(selectionFromNodeId("agent:coder")).toBeNull();
  });
});
