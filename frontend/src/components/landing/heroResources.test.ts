import { describe, expect, it, vi } from "vitest";
import { createHeroResources, GRID_SIZE, GRID_STEP, STAR_COUNT } from "./heroResources";
import { PIPELINE_EDGES, pipelineNode } from "./pipeline";

describe("hero scene resources", () => {
  it("disposes every geometry, material and shader it created", () => {
    const resources = createHeroResources();
    // Geometries: core, shell, rim, gyro ring, coder, 3 coder rings, reviewer,
    // scan ring, verifier, shock ring, packet, stars, glow, grid, 7 tubes = 23.
    // Materials: 7 tubes, core, rim shader, wire, gyro, 3 coders, 3 coder
    // rings, reviewer, scan, verifier, shock, packet, stars, glow, grid = 25.
    expect(resources.all).toHaveLength(23 + 25);
    expect(new Set(resources.all).size).toBe(resources.all.length);
    expect(resources.all).toContain(resources.rimMaterial);
    const spies = resources.all.map((resource) => vi.spyOn(resource, "dispose"));
    resources.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it("gives each mounted scene its own resources", () => {
    const first = createHeroResources();
    const second = createHeroResources();
    expect(first.core).not.toBe(second.core);
    expect(first.rimMaterial).not.toBe(second.rimMaterial);
    first.dispose();
    second.dispose();
  });

  it("draws a curved path for every edge, from its source to its target", () => {
    const resources = createHeroResources();
    expect(Object.keys(resources.curves)).toEqual(PIPELINE_EDGES.map((edge) => edge.id));
    for (const edge of PIPELINE_EDGES) {
      const curve = resources.curves[edge.id];
      expect(curve.getPoint(0).toArray()).toEqual(pipelineNode(edge.from).position);
      expect(curve.getPoint(1).toArray()).toEqual(pipelineNode(edge.to).position);
      // Bowed towards the viewer, not a straight line.
      const straightZ = (pipelineNode(edge.from).position[2] + pipelineNode(edge.to).position[2]) / 2;
      expect(curve.getPoint(0.5).z).toBeGreaterThan(straightZ);
      expect(resources.tubes[edge.id]).toBeDefined();
      expect(resources.tubeMaterials[edge.id]).toBeDefined();
    }
    resources.dispose();
  });

  it("draws the same starfield on every mount, behind the pipeline", () => {
    const first = createHeroResources();
    const second = createHeroResources();
    const positions = first.stars.getAttribute("position");
    expect(positions.count).toBe(STAR_COUNT);
    expect(Array.from(positions.array)).toEqual(Array.from(second.stars.getAttribute("position").array));
    for (let i = 0; i < positions.count; i += 1) expect(positions.getZ(i)).toBeLessThanOrEqual(-2);
    first.dispose();
    second.dispose();
  });

  it("lays a floor grid of line segments below the pipeline", () => {
    const { grid, dispose } = createHeroResources();
    const lines = GRID_SIZE / GRID_STEP + 1; // per direction
    const positions = grid.getAttribute("position");
    expect(positions.count).toBe(lines * 2 * 2); // two directions, two points per line
    for (let i = 0; i < positions.count; i += 1) expect(positions.getY(i)).toBe(0);
    dispose();
  });

  it("pulses the planner's rim through shader uniforms", () => {
    const { rimMaterial, dispose } = createHeroResources();
    expect(Object.keys(rimMaterial.uniforms)).toEqual(["uColor", "uTime", "uIntensity"]);
    expect(rimMaterial.fragmentShader).toContain("uIntensity");
    expect(rimMaterial.transparent).toBe(true);
    dispose();
  });
});
