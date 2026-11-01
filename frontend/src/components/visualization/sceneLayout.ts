/**
 * World positions for the 3D scene, from the model's grid. Kept free of
 * three.js so it can be tested without WebGL and stays out of the 3D chunk's
 * critical path.
 */
import type { VizModel, VizNode } from "@/domain/visualization";

export const COLUMN_SPACING = 3;
export const ROW_SPACING = 1.8;

export type Vec3 = [number, number, number];

/** Columns run left to right, centred on the origin; rows stack downwards. */
export function scenePosition(node: Pick<VizNode, "column" | "row">, columns: number): Vec3 {
  return [(node.column - (columns - 1) / 2) * COLUMN_SPACING, -node.row * ROW_SPACING, 0];
}

/** Every node's position, by id. */
export function scenePositions(model: VizModel): Map<string, Vec3> {
  return new Map(model.nodes.map((node) => [node.id, scenePosition(node, model.columns)]));
}

/** The centre of the given points; the origin for none. */
export function centroid(points: Vec3[]): Vec3 {
  if (points.length === 0) return [0, 0, 0];
  const sum = points.reduce<Vec3>((acc, [x, y, z]) => [acc[0] + x, acc[1] + y, acc[2] + z], [0, 0, 0]);
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
}

/** A camera distance that keeps the whole grid in view. */
export function cameraDistance(model: VizModel): number {
  const rows = Math.max(1, ...model.waves.map((wave) => wave.stepIds.length));
  const width = model.columns * COLUMN_SPACING;
  const height = rows * ROW_SPACING;
  return Math.max(8, width * 0.9, height * 1.6);
}
