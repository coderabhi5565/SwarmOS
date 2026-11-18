import { describe, expect, it, vi } from "vitest";
import { createHeroResources } from "./heroResources";

describe("hero scene resources", () => {
  it("disposes every geometry and material it created", () => {
    const resources = createHeroResources();
    // 3 geometries, a node and a halo material per role (4 + 4), and the pulse material.
    expect(resources.all).toHaveLength(3 + 4 + 4 + 1);
    expect(new Set(resources.all).size).toBe(resources.all.length);
    const spies = resources.all.map((resource) => vi.spyOn(resource, "dispose"));
    resources.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it("gives each mounted scene its own resources", () => {
    const first = createHeroResources();
    const second = createHeroResources();
    expect(first.nodeGeometry).not.toBe(second.nodeGeometry);
    expect(first.nodeMaterials.planner).not.toBe(second.nodeMaterials.planner);
    first.dispose();
    second.dispose();
  });
});
