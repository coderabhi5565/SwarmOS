/**
 * The landing hero in 3D: the orchestration pipeline as a small graph with
 * pulses travelling along its edges. Loaded on demand by HeroVisual, and only
 * when WebGL2 is available and reduced motion is off: three.js and React
 * Three Fiber never reach the landing page's own bundle.
 *
 * The scene owns its geometries and materials (heroResources) and disposes
 * all of them on unmount; meshes use dispose={null} so nothing is freed twice.
 */
import { Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Group, Mesh } from "three";
import { createHeroResources, type HeroResources } from "./heroResources";
import { PIPELINE_EDGES, PIPELINE_NODES, pipelineNode, type PipelineNode } from "./pipeline";

export interface HeroScene3DProps {
  /** The browser dropped the WebGL context. */
  onContextLost: () => void;
}

export default function HeroScene3D({ onContextLost }: HeroScene3DProps) {
  const resources = useMemo(createHeroResources, []);
  useEffect(() => () => resources.dispose(), [resources]);
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div className="relative size-full" style={{ cursor: hovered ? "pointer" : "grab" }}>
      <Canvas
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: "low-power" }}
        camera={{ position: [0, 1.4, 10.5], fov: 42, near: 0.1, far: 100 }}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener("webglcontextlost", (event) => {
            event.preventDefault();
            onContextLost();
          });
        }}
        aria-hidden="true"
        data-testid="hero-scene-3d"
      >
        <ambientLight intensity={0.6} />
        <directionalLight position={[4, 6, 8]} intensity={1.2} />
        {PIPELINE_EDGES.map((edge, index) => (
          <Edge key={edge.id} from={pipelineNode(edge.from)} to={pipelineNode(edge.to)} index={index} resources={resources} />
        ))}
        {PIPELINE_NODES.map((node) => (
          <Node key={node.id} node={node} resources={resources} hovered={hovered === node.id} onHover={setHovered} />
        ))}
        {/* Damped orbit; zoom and pan stay off so the page still scrolls. */}
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          enableZoom={false}
          enablePan={false}
          autoRotate={hovered === null}
          autoRotateSpeed={0.5}
          minPolarAngle={Math.PI / 3}
          maxPolarAngle={(2 * Math.PI) / 3}
        />
      </Canvas>
    </div>
  );
}

function Node({
  node,
  resources,
  hovered,
  onHover,
}: {
  node: PipelineNode;
  resources: HeroResources;
  hovered: boolean;
  onHover: (id: string | null) => void;
}) {
  const group = useRef<Group>(null);
  const halo = useRef<Mesh>(null);
  useFrame((_, delta) => {
    if (!group.current || !halo.current) return;
    const target = hovered ? 1.22 : 1;
    const scale = group.current.scale.x + (target - group.current.scale.x) * Math.min(1, delta * 10);
    group.current.scale.setScalar(scale);
    halo.current.rotation.z += delta * 0.6;
  });
  return (
    <group position={node.position}>
      <group ref={group}>
        <mesh
          geometry={resources.nodeGeometry}
          material={resources.nodeMaterials[node.role]}
          dispose={null}
          onPointerOver={(event) => {
            event.stopPropagation();
            onHover(node.id);
          }}
          onPointerOut={() => onHover(null)}
        />
        <mesh ref={halo} geometry={resources.haloGeometry} material={resources.haloMaterials[node.role]} dispose={null} />
      </group>
      <Html center position={[0, -0.95, 0]} style={{ pointerEvents: "none" }} zIndexRange={[10, 0]}>
        <span className="font-mono text-[10px] whitespace-nowrap text-muted-foreground">{node.label}</span>
      </Html>
      {hovered && (
        <Html center position={[0, 1.15, 0]} style={{ pointerEvents: "none" }} zIndexRange={[20, 10]}>
          <div role="tooltip" className="glass w-56 rounded-lg px-3 py-2 text-left text-xs shadow-lg">
            <p className="font-medium text-foreground">{node.label}</p>
            <p className="mt-0.5 text-muted-foreground">{node.description}</p>
          </div>
        </Html>
      )}
    </group>
  );
}

/** A dependency edge, and one pulse travelling along it. */
function Edge({ from, to, index, resources }: { from: PipelineNode; to: PipelineNode; index: number; resources: HeroResources }) {
  const pulse = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (!pulse.current) return;
    // Staggered, so the wave's three branches do not move in lockstep.
    const t = (clock.elapsedTime * 0.35 + index * 0.37) % 1;
    pulse.current.position.set(
      from.position[0] + (to.position[0] - from.position[0]) * t,
      from.position[1] + (to.position[1] - from.position[1]) * t,
      from.position[2] + (to.position[2] - from.position[2]) * t,
    );
  });
  return (
    <>
      <Line points={[from.position, to.position]} color="#64748b" lineWidth={1} transparent opacity={0.55} />
      <mesh ref={pulse} geometry={resources.pulseGeometry} material={resources.pulseMaterial} dispose={null} />
    </>
  );
}
