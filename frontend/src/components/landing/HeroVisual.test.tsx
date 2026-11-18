import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeroScene3DProps } from "./HeroScene3D";
import { HeroVisual, webgl2Available } from "./HeroVisual";
import { PIPELINE_EDGES, PIPELINE_NODES, pipelineNode } from "./pipeline";

// The real scene needs WebGL2, which jsdom lacks. The stand-in records that
// the module was loaded, exposes its props and can fail on request.
const scene = vi.hoisted(() => ({ loaded: false, fail: false, props: null as HeroScene3DProps | null }));
vi.mock("./HeroScene3D", () => {
  scene.loaded = true;
  return {
    default: (props: HeroScene3DProps) => {
      if (scene.fail) throw new Error("context creation failed");
      scene.props = props;
      return <div data-testid="scene-stand-in" />;
    },
  };
});

function stubWebgl2(available: boolean) {
  if (available) vi.stubGlobal("WebGL2RenderingContext", class {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    ((kind: string) => (available && kind === "webgl2" ? {} : null)) as never,
  );
}

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

beforeEach(() => {
  scene.fail = false;
  scene.props = null;
});
afterEach(() => vi.unstubAllGlobals());

describe("HeroVisual", () => {
  it("draws the 2D diagram without WebGL2, loads no 3D code and logs nothing", async () => {
    const errors = vi.spyOn(console, "error");
    const warnings = vi.spyOn(console, "warn");
    const { container } = render(<HeroVisual />); // jsdom as it is: no WebGL2 at all
    expect(screen.getByTestId("hero-pipeline-2d")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("data-hero", "no-webgl2");
    await act(async () => {});
    expect(screen.queryByTestId("scene-stand-in")).not.toBeInTheDocument();
    // First test in the file: nothing has imported the scene module yet.
    expect(scene.loaded).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });

  it("treats WebGL1 alone as unavailable", () => {
    vi.stubGlobal("WebGL2RenderingContext", class {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      ((kind: string) => (kind === "webgl" ? {} : null)) as never,
    );
    expect(webgl2Available()).toBe(false);
  });

  it("draws the 2D diagram under reduced motion, though WebGL2 is available", async () => {
    stubWebgl2(true);
    stubReducedMotion(true);
    const { container } = render(<HeroVisual />);
    expect(container.firstElementChild).toHaveAttribute("data-hero", "reduced-motion");
    expect(screen.getByTestId("hero-pipeline-2d")).toBeInTheDocument();
    await act(async () => {});
    expect(screen.queryByTestId("scene-stand-in")).not.toBeInTheDocument();
    expect(scene.loaded).toBe(false);
  });

  it("loads the 3D scene lazily with WebGL2 and motion allowed, and lists the pipeline for screen readers", async () => {
    stubWebgl2(true);
    stubReducedMotion(false);
    const { container } = render(<HeroVisual />);
    expect(await screen.findByTestId("scene-stand-in")).toBeInTheDocument();
    expect(scene.loaded).toBe(true);
    expect(container.firstElementChild).toHaveAttribute("data-hero", "3d");
    expect(screen.queryByTestId("hero-pipeline-2d")).not.toBeInTheDocument();
    const stages = screen.getByRole("list", { name: "SwarmOS pipeline" });
    expect(stages.querySelectorAll("li")).toHaveLength(6);
    expect(stages).toHaveTextContent("Reviewer evidence guard: A blocker must cite a real file, line and test output");
  });

  it("passes the scene's phase on, and says when there is none to follow", async () => {
    stubWebgl2(true);
    stubReducedMotion(false);
    const onPhase = vi.fn();
    render(<HeroVisual onPhase={onPhase} />);
    await screen.findByTestId("scene-stand-in");
    act(() => scene.props?.onPhase?.("evidence-guard"));
    expect(onPhase).toHaveBeenLastCalledWith("evidence-guard");
    act(() => scene.props?.onContextLost()); // back to the 2D diagram
    expect(onPhase).toHaveBeenLastCalledWith(null);
  });

  it("reports no phase with the 2D diagram", () => {
    const onPhase = vi.fn();
    render(<HeroVisual onPhase={onPhase} />); // jsdom: no WebGL2
    expect(onPhase).toHaveBeenCalledWith(null);
    expect(onPhase).toHaveBeenCalledTimes(1);
  });

  it("returns to the 2D diagram when the WebGL context is lost", async () => {
    stubWebgl2(true);
    stubReducedMotion(false);
    const { container } = render(<HeroVisual />);
    await screen.findByTestId("scene-stand-in");
    act(() => scene.props?.onContextLost());
    expect(container.firstElementChild).toHaveAttribute("data-hero", "context-lost");
    expect(screen.getByTestId("hero-pipeline-2d")).toBeInTheDocument();
    expect(screen.queryByTestId("scene-stand-in")).not.toBeInTheDocument();
  });

  it("returns to the 2D diagram when the scene fails to start", async () => {
    stubWebgl2(true);
    stubReducedMotion(false);
    scene.fail = true;
    vi.spyOn(console, "error").mockImplementation(() => {}); // React reports the caught error
    const { container } = render(<HeroVisual />);
    expect(await screen.findByTestId("hero-pipeline-2d")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("data-hero", "scene-error");
  });
});

describe("the 2D diagram and the pipeline", () => {
  it("names every stage, with its description as a title", () => {
    render(<HeroVisual />);
    const diagram = screen.getByRole("img", { name: /planner, a parallel wave of three coders, the reviewer evidence guard/ });
    for (const label of ["Planner", "Coder A", "Coder B", "Coder C"]) expect(diagram).toHaveTextContent(label);
    expect(diagram).toHaveTextContent("Reviewerevidence guard");
    expect(diagram).toHaveTextContent("Deterministicverifier");
    expect(diagram.querySelectorAll("line")).toHaveLength(PIPELINE_EDGES.length);
    expect(diagram.querySelector("title")).toHaveTextContent("Planner: Turns the goal into a typed plan");
  });

  it("is planner, a wave of three coders, the reviewer, then the verifier", () => {
    expect(PIPELINE_NODES.map((node) => node.role)).toEqual(["planner", "coder", "coder", "coder", "reviewer", "verifier"]);
    const targets = (id: string) => PIPELINE_EDGES.filter((edge) => edge.from === id).map((edge) => edge.to);
    expect(targets("planner")).toEqual(["coder-a", "coder-b", "coder-c"]);
    for (const coder of ["coder-a", "coder-b", "coder-c"]) expect(targets(coder)).toEqual(["reviewer"]);
    expect(targets("reviewer")).toEqual(["verifier"]);
    expect(targets("verifier")).toEqual([]);
    for (const edge of PIPELINE_EDGES) expect(() => [pipelineNode(edge.from), pipelineNode(edge.to)]).not.toThrow();
  });
});
