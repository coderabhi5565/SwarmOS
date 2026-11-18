/**
 * The landing hero in 3D: the orchestration pipeline as a small spatial
 * scene that plays one execution cycle on a loop (simulation.ts) and lets a
 * visitor focus a node (heroFocus.ts, HeroHud). Loaded on demand by
 * HeroVisual, and only when WebGL2 is available and reduced motion is off:
 * three.js and React Three Fiber never reach the landing page's own bundle.
 *
 * The scene owns its geometries, materials and shader (heroResources) and
 * disposes all of them on unmount; meshes use dispose={null} so nothing is
 * freed twice. One useFrame drives everything from the simulation state.
 */
import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useReducer, useRef, type Dispatch } from "react";
import { Vector3, type Group, type Mesh } from "three";
import { createHeroResources, type HeroResources } from "./heroResources";
import { focusedNode, focusReducer, NO_FOCUS, type FocusAction } from "./heroFocus";
import { HeroHud } from "./HeroHud";
import { CODER_IDS, connectedEdges, PIPELINE_EDGES, pipelineNode } from "./pipeline";
import { simulationState, type PhaseId } from "./simulation";

export interface HeroScene3DProps {
  /** The browser dropped the WebGL context. */
  onContextLost: () => void;
  /** The execution cycle moved to another phase. */
  onPhase?: (phase: PhaseId) => void;
}

/** Fog colour: the page's dark background, so distance fades into it. */
const FOG = "#0b1020";
/** On a wide stage the pipeline sits to the right, clear of the headline. */
const WIDE_STAGE_PX = 1024;
const WIDE_OFFSET_X = 2.6;

export default function HeroScene3D({ onContextLost, onPhase }: HeroScene3DProps) {
  const resources = useMemo(createHeroResources, []);
  useEffect(() => () => resources.dispose(), [resources]);
  const [focus, dispatch] = useReducer(focusReducer, NO_FOCUS);
  const focused = focusedNode(focus);

  return (
    <div className="relative size-full" style={{ cursor: focus.hovered ? "pointer" : "grab" }}>
      <Canvas
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: "low-power" }}
        camera={{ position: [0, 0.9, 8.6], fov: 44, near: 0.1, far: 100 }}
        onPointerMissed={() => dispatch({ type: "clear" })}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener("webglcontextlost", (event) => {
            event.preventDefault();
            onContextLost();
          });
        }}
        aria-hidden="true"
        data-testid="hero-scene-3d"
      >
        <fogExp2 attach="fog" args={[FOG, 0.045]} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[4, 6, 8]} intensity={1.5} />
        <Scene resources={resources} focused={focused} dispatch={dispatch} onPhase={onPhase} />
        {/* Damped orbit; zoom and pan stay off so the page still scrolls. */}
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          enableZoom={false}
          enablePan={false}
          autoRotate={focused === null}
          autoRotateSpeed={0.35}
          minPolarAngle={Math.PI / 3}
          maxPolarAngle={(2 * Math.PI) / 3}
          minAzimuthAngle={-Math.PI / 4}
          maxAzimuthAngle={Math.PI / 4}
        />
      </Canvas>
      <HeroHud focused={focused} locked={focus.locked} onSelect={(id) => dispatch({ type: "toggle", id })} />
    </div>
  );
}

function Scene({
  resources,
  focused,
  dispatch,
  onPhase,
}: {
  resources: HeroResources;
  focused: string | null;
  dispatch: Dispatch<FocusAction>;
  onPhase?: (phase: PhaseId) => void;
}) {
  const wide = useThree((state) => state.size.width >= WIDE_STAGE_PX);
  const controls = useThree((state) => state.controls) as { target: Vector3 } | null;
  const offsetX = wide ? WIDE_OFFSET_X : 0;
  const scale = wide ? 1 : 0.72;
  const aim = useMemo(() => new Vector3(), []);
  const reported = useRef(false);
  const parallax = useRef<Group>(null);
  const stars = useRef<Group>(null);
  const gyro = useRef<(Group | null)[]>([]);
  const plannerPulse = useRef<Mesh>(null);
  const coderMeshes = useRef<(Mesh | null)[]>([]);
  const coderRings = useRef<(Mesh | null)[]>([]);
  const scan = useRef<Mesh>(null);
  const verifierMesh = useRef<Mesh>(null);
  const shock = useRef<Mesh>(null);
  const packets = useRef<Record<string, Mesh | null>>({});
  const nodeGroups = useRef<Record<string, Group | null>>({});
  const lastPhase = useRef<PhaseId>("plan");
  const highlighted = useMemo(() => (focused ? new Set(connectedEdges(focused)) : null), [focused]);

  useFrame(({ clock, pointer }, delta) => {
    const sim = simulationState(clock.elapsedTime);
    if (sim.phase !== lastPhase.current || !reported.current) {
      lastPhase.current = sim.phase;
      reported.current = true;
      onPhase?.(sim.phase);
    }
    const ease = Math.min(1, delta * 4);

    // The camera eases towards a focused node (part of the way), and back.
    if (controls) {
      aim.set(offsetX, 0, 0);
      if (focused) {
        const [x, y, z] = pipelineNode(focused).position;
        aim.set(offsetX + x * scale * 0.45, y * scale * 0.45, z * scale * 0.45);
      }
      controls.target.lerp(aim, Math.min(1, delta * 2.5));
    }

    // Pointer parallax, layered over the orbit controls' camera.
    if (parallax.current) {
      parallax.current.rotation.y += (pointer.x * 0.12 - parallax.current.rotation.y) * ease;
      parallax.current.rotation.x += (-pointer.y * 0.07 - parallax.current.rotation.x) * ease;
    }
    if (stars.current) {
      stars.current.rotation.y = clock.elapsedTime * 0.01 - pointer.x * 0.03;
      stars.current.rotation.x = pointer.y * 0.02;
    }

    // Planner: gyroscope rings, rim shader, radiating pulse.
    gyro.current.forEach((ring, index) => {
      if (!ring) return;
      ring.rotation.x += delta * (0.5 + index * 0.25);
      ring.rotation.y += delta * (0.35 - index * 0.2);
    });
    resources.rimMaterial.uniforms.uTime.value = clock.elapsedTime;
    resources.rimMaterial.uniforms.uIntensity.value = 0.8 + sim.glow.planner * 1.2;
    resources.coreMaterial.emissiveIntensity = 1.2 + sim.glow.planner * 1.8;
    resources.glowMaterial.opacity = 0.1 + sim.glow.planner * 0.16;
    if (plannerPulse.current) {
      const pulse = sim.plannerPulse;
      plannerPulse.current.visible = pulse !== null;
      if (pulse !== null) plannerPulse.current.scale.setScalar(1 + pulse * 3.2);
    }

    // Coders: glow and progress ring.
    CODER_IDS.forEach((id, index) => {
      resources.coderMaterials[index].emissiveIntensity = 0.25 + sim.glow[id] * 1.5;
      const mesh = coderMeshes.current[index];
      if (mesh) mesh.rotation.y += delta * (0.4 + sim.glow[id] * 2);
      const geometry = resources.coderRings[index];
      const total = geometry.index ? geometry.index.count : 0;
      geometry.setDrawRange(0, Math.floor((total * sim.coderProgress[index]) / 3) * 3);
      const ring = coderRings.current[index];
      if (ring) ring.rotation.z = -clock.elapsedTime * 0.3;
    });

    // Reviewer: the scanning ring sweeps, then flashes.
    resources.reviewerMaterial.emissiveIntensity = 0.3 + sim.glow.reviewer * 1.2;
    if (scan.current) {
      const sweep = sim.guardScan;
      scan.current.position.y = sweep === null ? 0 : Math.sin(sweep * Math.PI * 2) * 0.42;
      scan.current.rotation.z += delta * 0.8;
      scan.current.scale.setScalar(1 + sim.guardFlash * 0.5);
    }
    resources.scanMaterial.color.set(sim.guardFlash > 0.05 ? "#34d399" : "#fbbf24");
    resources.scanMaterial.opacity = 0.55 + sim.guardFlash * 0.45;

    // Verifier: glow, slow turn, expanding shockwave.
    resources.verifierMaterial.emissiveIntensity = 0.3 + sim.glow.verifier * 1.8;
    if (verifierMesh.current) verifierMesh.current.rotation.y += delta * 0.5;
    if (shock.current) {
      const wave = sim.shockwave;
      shock.current.visible = wave !== null;
      if (wave !== null) {
        shock.current.scale.setScalar(1 + wave * 4);
        resources.shockMaterial.opacity = (1 - wave) * 0.8;
      }
    }

    // Packets along their curves; edges of a focused node stand out.
    for (const edge of PIPELINE_EDGES) {
      const packet = packets.current[edge.id];
      const progress = sim.packets[edge.id];
      if (packet) {
        packet.visible = progress !== null;
        if (progress !== null) resources.curves[edge.id].getPoint(progress, packet.position);
      }
      const material = resources.tubeMaterials[edge.id];
      const lit = highlighted === null ? 0.6 : highlighted.has(edge.id) ? 1 : 0.12;
      material.opacity += (lit - material.opacity) * ease;
      material.color.set(highlighted?.has(edge.id) ? "#7dd3fc" : "#64748b");
    }

    // The focused node grows a little.
    for (const [id, group] of Object.entries(nodeGroups.current)) {
      if (!group) continue;
      const target = id === focused ? 1.2 : 1;
      group.scale.setScalar(group.scale.x + (target - group.scale.x) * ease);
    }
  });

  const handlers = (id: string) => ({
    onPointerOver: (event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      dispatch({ type: "hover", id });
    },
    onPointerOut: () => dispatch({ type: "leave", id }),
    onClick: (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      dispatch({ type: "toggle", id });
    },
  });
  const nodeRef = (id: string) => (group: Group | null) => {
    nodeGroups.current[id] = group;
  };
  const reviewer = pipelineNode("reviewer");
  const verifier = pipelineNode("verifier");

  return (
    <>
      <group ref={stars}>
        <points geometry={resources.stars} material={resources.starMaterial} dispose={null} />
      </group>
      <lineSegments geometry={resources.grid} material={resources.gridMaterial} position={[offsetX, -3.2, -4]} dispose={null} />
      <group position={[offsetX, 0, 0]} scale={scale}>
      <group ref={parallax}>
        {PIPELINE_EDGES.map((edge) => (
          <group key={edge.id}>
            <mesh geometry={resources.tubes[edge.id]} material={resources.tubeMaterials[edge.id]} dispose={null} />
            <mesh
              ref={(mesh) => {
                packets.current[edge.id] = mesh;
              }}
              geometry={resources.packet}
              material={resources.packetMaterial}
              visible={false}
              dispose={null}
            />
          </group>
        ))}

        <group position={pipelineNode("planner").position} ref={nodeRef("planner")}>
          <mesh geometry={resources.core} material={resources.coreMaterial} dispose={null} {...handlers("planner")} />
          <mesh geometry={resources.shell} material={resources.wireMaterial} dispose={null} />
          <mesh geometry={resources.rim} material={resources.rimMaterial} dispose={null} />
          <mesh geometry={resources.glow} material={resources.glowMaterial} dispose={null} />
          <pointLight intensity={8} color="#a78bfa" distance={8} />
          {[0, 1, 2].map((index) => (
            <group
              key={index}
              ref={(group) => {
                gyro.current[index] = group;
              }}
              rotation={[index * 1.1, index * 0.7, 0]}
            >
              <mesh geometry={resources.gyroRing} material={resources.gyroMaterial} scale={1 - index * 0.12} dispose={null} />
            </group>
          ))}
          <mesh ref={plannerPulse} geometry={resources.gyroRing} material={resources.gyroMaterial} visible={false} dispose={null} />
        </group>

        {CODER_IDS.map((id, index) => (
          <group key={id} position={pipelineNode(id).position} ref={nodeRef(id)}>
            <mesh
              ref={(mesh) => {
                coderMeshes.current[index] = mesh;
              }}
              geometry={resources.coder}
              material={resources.coderMaterials[index]}
              dispose={null}
              {...handlers(id)}
            />
            <mesh
              ref={(mesh) => {
                coderRings.current[index] = mesh;
              }}
              geometry={resources.coderRings[index]}
              material={resources.coderRingMaterials[index]}
              dispose={null}
            />
          </group>
        ))}

        <group position={reviewer.position} ref={nodeRef("reviewer")}>
          <mesh geometry={resources.reviewer} material={resources.reviewerMaterial} dispose={null} {...handlers("reviewer")} />
          <mesh ref={scan} geometry={resources.scanRing} material={resources.scanMaterial} rotation={[Math.PI / 2, 0, 0]} dispose={null} />
        </group>

        <group position={verifier.position} ref={nodeRef("verifier")}>
          <mesh ref={verifierMesh} geometry={resources.verifier} material={resources.verifierMaterial} dispose={null} {...handlers("verifier")} />
          <mesh ref={shock} geometry={resources.shockRing} material={resources.shockMaterial} visible={false} dispose={null} />
        </group>
      </group>
      </group>
    </>
  );
}
