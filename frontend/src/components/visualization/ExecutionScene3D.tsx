/**
 * The run as a 3D scene. Loaded on demand (React.lazy) only after someone
 * picks the 3D view and only when WebGL is available: three.js and
 * React Three Fiber never reach the initial bundle.
 *
 * Renders on demand: a frame is drawn when the model, the selection or the
 * camera changes. Continuous frames run only while the trace shows work
 * running and reduced motion is off, and then only to turn the running nodes.
 */
import { Line, OrbitControls, QuadraticBezierLine } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Vector3, type Group } from "three";
import type { VizEdge, VizModel, VizNode } from "@/domain/visualization";
import { cn } from "@/lib/utils";
import { selectionFromNodeId, selectionNodeId, useViewStore } from "@/store/viewStore";
import { SCENE_COLORS, statusLabel, statusTone } from "./presentation";
import { cameraDistance, centroid, scenePositions, type Vec3 } from "./sceneLayout";

/** A little above the grid, so the status rings read as rings. */
const CAMERA_HEIGHT = 3.2;

export interface ExecutionScene3DProps {
  model: VizModel;
  live: boolean;
  reducedMotion: boolean;
  /** Changes when the user asks for the default camera again. */
  resetKey: number;
  /** The browser dropped the WebGL context. */
  onContextLost: () => void;
}

export default function ExecutionScene3D({ model, live, reducedMotion, resetKey, onContextLost }: ExecutionScene3DProps) {
  const positions = useMemo(() => scenePositions(model), [model]);
  const distance = cameraDistance(model);
  const animate = !reducedMotion && model.nodes.some((node) => node.active);
  const clearSelection = useViewStore((state) => state.clearSelection);

  const labels = useRef(new Map<string, HTMLDivElement>());

  return (
    <div className="relative size-full">
      <Canvas
        frameloop={animate ? "always" : "demand"}
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: "low-power" }}
        camera={{ position: [0, CAMERA_HEIGHT, distance], fov: 45, near: 0.1, far: 200 }}
        onPointerMissed={clearSelection}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener("webglcontextlost", (event) => {
            event.preventDefault();
            onContextLost();
          });
        }}
        aria-hidden="true"
        data-testid="execution-scene-3d"
      >
        <ambientLight intensity={0.55} />
        <directionalLight position={[4, 6, 8]} intensity={1.1} />
        <Edges model={model} positions={positions} />
        <Nodes model={model} positions={positions} animate={animate} />
        <OrbitControls makeDefault enableDamping={false} minDistance={3} maxDistance={distance * 2.5} />
        <CameraRig model={model} positions={positions} distance={distance} follow={live} resetKey={resetKey} />
        <LabelProjector positions={positions} labels={labels} />
      </Canvas>
      <Labels model={model} labels={labels} />
    </div>
  );
}

/**
 * Node labels as plain DOM over the canvas, moved by LabelProjector on each
 * rendered frame. (Cheaper than a React root per label, and the text stays
 * crisp at any zoom.)
 */
function Labels({ model, labels }: { model: VizModel; labels: RefObject<Map<string, HTMLDivElement>> }) {
  const selectedId = useViewStore((state) => selectionNodeId(state.selection));
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {model.nodes.map((node) => (
        <div
          key={node.id}
          ref={(element) => {
            if (element) labels.current.set(node.id, element);
            else labels.current.delete(node.id);
          }}
          // Hidden until the first frame places it; the projector's inline style wins.
          className={cn(
            "invisible absolute top-0 left-0 flex flex-col items-center whitespace-nowrap rounded-md border bg-background/85 px-1.5 py-0.5 font-mono text-[10px] leading-tight",
            node.id === selectedId ? "border-ring" : "border-border",
          )}
        >
          <span className="max-w-32 truncate text-foreground">{node.label}</span>
          <span style={{ color: SCENE_COLORS[statusTone(node)] }}>{statusLabel(node, model.finished)}</span>
        </div>
      ))}
    </div>
  );
}

const LABEL_OFFSET = 1.15;

function LabelProjector({ positions, labels }: { positions: Map<string, Vec3>; labels: RefObject<Map<string, HTMLDivElement>> }) {
  const point = useMemo(() => new Vector3(), []);
  useFrame(({ camera, size }) => {
    for (const [id, element] of labels.current) {
      const position = positions.get(id);
      if (!position) continue;
      point.set(position[0], position[1] - LABEL_OFFSET, position[2]).project(camera);
      const x = (point.x * 0.5 + 0.5) * size.width;
      const y = (-point.y * 0.5 + 0.5) * size.height;
      element.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      element.style.visibility = point.z > 1 ? "hidden" : "visible";
    }
  });
  return null;
}

function Nodes({ model, positions, animate }: { model: VizModel; positions: Map<string, Vec3>; animate: boolean }) {
  const selectedId = useViewStore((state) => selectionNodeId(state.selection));
  return (
    <>
      {model.nodes.map((node) => (
        <NodeEntity
          key={node.id}
          node={node}
          position={positions.get(node.id)!}
          selected={node.id === selectedId}
          animate={animate && node.active}
        />
      ))}
    </>
  );
}

const NodeEntity = memo(function NodeEntity({
  node,
  position,
  selected,
  animate,
}: {
  node: VizNode;
  position: Vec3;
  selected: boolean;
  animate: boolean;
}) {
  const spinner = useRef<Group>(null);
  const select = useViewStore((state) => state.select);
  useFrame((_, delta) => {
    if (animate && spinner.current) spinner.current.rotation.y += delta * 0.9;
  });
  const color = SCENE_COLORS[node.role];
  const ring = SCENE_COLORS[statusTone(node)];
  // Work that has not run (or was never reached) is drawn translucent.
  const faded = ["idle", "pending", "queued", "skipped"].includes(node.status);

  return (
    <group position={position}>
      <group ref={spinner} scale={selected ? 1.18 : 1}>
        <mesh
          onClick={(event) => {
            event.stopPropagation();
            select(selectionFromNodeId(node.id));
          }}
        >
          <NodeGeometry node={node} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={node.active ? 0.65 : selected ? 0.35 : 0.08}
            transparent={faded}
            opacity={faded ? 0.35 : 1}
            roughness={0.5}
            metalness={node.kind === "runner" ? 0.6 : 0.1}
            flatShading={node.kind !== "step"}
          />
        </mesh>
      </group>
      {/* Status ring under the entity. */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -0.72, 0]}>
        <torusGeometry args={[0.62, selected ? 0.07 : 0.035, 8, 48]} />
        <meshBasicMaterial color={selected ? "#ffffff" : ring} />
      </mesh>
    </group>
  );
});

/** Distinct shapes per kind of actor; the runner is a machine, not an agent. */
function NodeGeometry({ node }: { node: VizNode }) {
  if (node.kind === "runner") return <cylinderGeometry args={[0.5, 0.5, 0.85, 6]} />;
  if (node.kind === "step") return <boxGeometry args={[0.8, 0.8, 0.8]} />;
  if (node.role === "planner") return <octahedronGeometry args={[0.6]} />;
  return <dodecahedronGeometry args={[0.55]} />;
}

const EDGE_COLOR: Record<VizEdge["kind"], string> = {
  flow: SCENE_COLORS.edge,
  dependency: "#4cc9e6",
  revision: SCENE_COLORS.findings,
  repair: SCENE_COLORS.failed,
};

function Edges({ model, positions }: { model: VizModel; positions: Map<string, Vec3> }) {
  return (
    <>
      {model.edges.map((edge) => (
        <EdgeLine key={edge.id} edge={edge} from={positions.get(edge.source)!} to={positions.get(edge.target)!} />
      ))}
    </>
  );
}

const EdgeLine = memo(function EdgeLine({ edge, from, to }: { edge: VizEdge; from: Vec3; to: Vec3 }) {
  const color = EDGE_COLOR[edge.kind];
  const width = edge.active ? 3 : edge.kind === "flow" ? 1 : 1.6;
  const opacity = edge.kind === "flow" && !edge.active ? 0.45 : 1;
  if (edge.kind === "revision" || edge.kind === "repair") {
    // Feedback arcs over the grid, back to the step.
    const mid: Vec3 = [(from[0] + to[0]) / 2, Math.max(from[1], to[1]) + 2.2, 1.2];
    return (
      <QuadraticBezierLine
        start={[from[0], from[1] + 0.6, 0]}
        end={[to[0], to[1] + 0.6, 0]}
        mid={mid}
        color={color}
        lineWidth={width}
        dashed
        dashSize={0.25}
        gapSize={0.15}
      />
    );
  }
  return (
    <Line
      points={[
        [from[0] + 0.65, from[1], 0],
        [to[0] - 0.65, to[1], 0],
      ]}
      color={color}
      lineWidth={width}
      transparent={opacity < 1}
      opacity={opacity}
    />
  );
});

/**
 * Points the orbit controls at the running work while a live run is
 * followed, and back at the whole graph when asked.
 */
function CameraRig({
  model,
  positions,
  distance,
  follow,
  resetKey,
}: {
  model: VizModel;
  positions: Map<string, Vec3>;
  distance: number;
  follow: boolean;
  resetKey: number;
}) {
  const followLive = useViewStore((state) => state.followLive);
  const { camera, controls, invalidate } = useThree();
  const activeKey = model.nodes
    .filter((node) => node.active)
    .map((node) => node.id)
    .join(" ");

  // Back to the whole graph on request, and once when the run stops being
  // live (it finished, or a replay started).
  const wasLive = useRef(follow);
  const [overview, setOverview] = useState(0);
  useEffect(() => {
    if (wasLive.current && !follow) setOverview((count) => count + 1);
    wasLive.current = follow;
  }, [follow]);

  useEffect(() => {
    camera.position.set(0, CAMERA_HEIGHT, distance);
    const orbit = controls as unknown as { target: { set: (x: number, y: number, z: number) => void }; update: () => void } | null;
    orbit?.target.set(0, 0, 0);
    orbit?.update();
    invalidate();
  }, [resetKey, overview, distance, camera, controls, invalidate]);

  useEffect(() => {
    if (!follow || !followLive || !activeKey || !controls) return;
    const [x, y, z] = centroid(activeKey.split(" ").map((id) => positions.get(id)!));
    const orbit = controls as unknown as { target: { set: (x: number, y: number, z: number) => void }; update: () => void };
    orbit.target.set(x, y, z);
    orbit.update();
    invalidate();
  }, [follow, followLive, activeKey, positions, controls, invalidate]);

  return null;
}
