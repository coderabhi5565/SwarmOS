/**
 * The hero scene's GPU resources: every geometry and material it uses,
 * created once per mounted scene and released together by `dispose`.
 * Imported only by HeroScene3D, so three.js stays in the lazy chunk.
 */
import {
  IcosahedronGeometry,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
  type Material,
} from "three";
import { ROLE_HEX, type PipelineRole } from "./pipeline";

const ROLES: PipelineRole[] = ["planner", "coder", "reviewer", "verifier"];

export interface HeroResources {
  nodeGeometry: BufferGeometry;
  haloGeometry: BufferGeometry;
  pulseGeometry: BufferGeometry;
  nodeMaterials: Record<PipelineRole, Material>;
  haloMaterials: Record<PipelineRole, Material>;
  pulseMaterial: Material;
  /** Every geometry and material above, for disposal and tests. */
  all: (BufferGeometry | Material)[];
  dispose: () => void;
}

export function createHeroResources(): HeroResources {
  const nodeGeometry = new IcosahedronGeometry(0.42, 1);
  const haloGeometry = new TorusGeometry(0.62, 0.012, 8, 48);
  const pulseGeometry = new SphereGeometry(0.07, 12, 12);
  const byRole = <T extends Material>(make: (color: string) => T) =>
    Object.fromEntries(ROLES.map((role) => [role, make(ROLE_HEX[role])])) as Record<PipelineRole, T>;
  const nodeMaterials = byRole(
    (color) => new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.35, metalness: 0.2, flatShading: true }),
  );
  const haloMaterials = byRole((color) => new MeshBasicMaterial({ color, transparent: true, opacity: 0.45 }));
  const pulseMaterial = new MeshBasicMaterial({ color: "#67e8f9" });
  const all = [
    nodeGeometry,
    haloGeometry,
    pulseGeometry,
    ...Object.values(nodeMaterials),
    ...Object.values(haloMaterials),
    pulseMaterial,
  ];
  return {
    nodeGeometry,
    haloGeometry,
    pulseGeometry,
    nodeMaterials,
    haloMaterials,
    pulseMaterial,
    all,
    dispose: () => all.forEach((resource) => resource.dispose()),
  };
}
