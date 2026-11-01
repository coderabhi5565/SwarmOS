import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay } from "@/domain/execution";
import { fixtures } from "@/domain/execution/fixtures";
import { buildVizModel } from "@/domain/visualization";
import { useViewStore } from "@/store/viewStore";
import type { ExecutionScene3DProps } from "./ExecutionScene3D";
import { cameraDistance, centroid, scenePosition } from "./sceneLayout";
import { Scene3DView } from "./Scene3DView";
import { resetWebglCheck } from "./webgl";

// The real scene needs WebGL, which jsdom lacks. The stand-in records that
// the module was loaded and can fail on request.
const scene = vi.hoisted(() => ({ loaded: false, fail: false, lastProps: null as unknown }));
vi.mock("./ExecutionScene3D", () => {
  scene.loaded = true;
  return {
    default: (props: ExecutionScene3DProps) => {
      if (scene.fail) throw new Error("context creation failed");
      scene.lastProps = props;
      return <div data-testid="scene-stand-in">{props.model.nodes.length} entities</div>;
    },
  };
});

const fixture = fixtures.verificationRepair;
const model = buildVizModel(replay(fixture.events, { seed: fixture.run, settle: true }));
const initial = useViewStore.getState();

function stubWebgl(available: boolean) {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => (available ? ({} as RenderingContext) : null) as never,
  );
  resetWebglCheck();
}

beforeEach(() => {
  useViewStore.setState(initial, true);
  scene.fail = false;
});
afterEach(() => resetWebglCheck());

describe("Scene3DView", () => {
  it("falls back to the 2D graph without WebGL, and never loads the scene", async () => {
    stubWebgl(false);
    render(<Scene3DView model={model} live={false} fallback={<div data-testid="graph-2d" />} />);
    expect(screen.getByRole("status")).toHaveTextContent("3D view unavailable: This browser or device does not provide WebGL.");
    expect(screen.getByTestId("graph-2d")).toBeInTheDocument();
    await act(async () => {});
    expect(screen.queryByTestId("scene-stand-in")).not.toBeInTheDocument();
    // First test in the file: nothing has imported the scene module yet.
    expect(scene.loaded).toBe(false);
  });

  it("loads the scene lazily when WebGL is available", async () => {
    stubWebgl(true);
    render(<Scene3DView model={model} live={false} fallback={<div data-testid="graph-2d" />} />);
    expect(await screen.findByTestId("scene-stand-in")).toHaveTextContent(`${model.nodes.length} entities`);
    expect(scene.loaded).toBe(true);
    expect(screen.queryByTestId("graph-2d")).not.toBeInTheDocument();
    expect(scene.lastProps).toMatchObject({ live: false, reducedMotion: false, resetKey: 0 });
  });

  it("falls back to 2D when the scene fails to start, keeping the selection", async () => {
    stubWebgl(true);
    scene.fail = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    useViewStore.getState().select({ kind: "runner" });
    render(<Scene3DView model={model} live={false} fallback={<div data-testid="graph-2d" />} />);
    expect(await screen.findByTestId("graph-2d")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("the 3D scene could not start (context creation failed)");
    expect(useViewStore.getState().selection).toEqual({ kind: "runner" });
  });

  it("offers every entity as a keyboard-selectable button", async () => {
    stubWebgl(true);
    render(<Scene3DView model={model} live={false} fallback={null} />);
    await screen.findByTestId("scene-stand-in");
    const list = screen.getByRole("navigation", { name: "Nodes in the 3D view" });
    const buttons = within(list).getAllByRole("button");
    expect(buttons).toHaveLength(model.nodes.length);
    fireEvent.click(within(list).getByRole("button", { name: /^Verification runner/ }));
    expect(useViewStore.getState().selection).toEqual({ kind: "runner" });
    expect(within(list).getByRole("button", { name: /^Verification runner/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("resets the camera on request", async () => {
    stubWebgl(true);
    render(<Scene3DView model={model} live={false} fallback={null} />);
    await screen.findByTestId("scene-stand-in");
    fireEvent.click(screen.getByRole("button", { name: "Reset camera" }));
    expect(scene.lastProps).toMatchObject({ resetKey: 1 });
  });
});

describe("scene layout", () => {
  it("centres the columns on the origin and stacks rows downwards", () => {
    expect(scenePosition({ column: 0, row: 0 }, 5)).toEqual([-6, -0, 0]);
    expect(scenePosition({ column: 4, row: 0 }, 5)).toEqual([6, -0, 0]);
    expect(scenePosition({ column: 1, row: 0.5 }, 5)).toEqual([-3, -0.9, 0]);
  });

  it("finds the centre of the running work", () => {
    expect(centroid([])).toEqual([0, 0, 0]);
    expect(centroid([[0, 1, 0], [2, -1, 0]])).toEqual([1, 0, 0]);
  });

  it("backs the camera off for wider graphs", () => {
    expect(cameraDistance(model)).toBeGreaterThanOrEqual(8);
    const wide = { ...model, columns: 12 };
    expect(cameraDistance(wide)).toBeGreaterThan(cameraDistance(model));
  });
});
