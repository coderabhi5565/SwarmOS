/**
 * The hero scene's GPU resources: every geometry, material and shader it
 * uses, created once per mounted scene and released together by `dispose`.
 * Imported only by HeroScene3D, so three.js stays in the lazy chunk.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DodecahedronGeometry,
  IcosahedronGeometry,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PointsMaterial,
  QuadraticBezierCurve3,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  type Material,
} from "three";
import { CODER_IDS, PIPELINE_EDGES, pipelineNode } from "./pipeline";

export const STAR_COUNT = 360;

/** A rim glow: brightest where the surface turns away from the camera. */
const FRESNEL_VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const FRESNEL_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uIntensity;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float rim = pow(1.0 - max(dot(normalize(vNormal), normalize(vView)), 0.0), 2.4);
    float breathe = 0.8 + 0.2 * sin(uTime * 2.0);
    gl_FragColor = vec4(uColor, rim * uIntensity * breathe);
  }
`;

/** Deterministic pseudo-random numbers, so every mount draws the same sky. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

export interface HeroResources {
  core: IcosahedronGeometry;
  shell: IcosahedronGeometry;
  rim: SphereGeometry;
  gyroRing: TorusGeometry;
  coder: DodecahedronGeometry;
  /** One per coder: its draw range is the coder's progress. */
  coderRings: TorusGeometry[];
  reviewer: IcosahedronGeometry;
  scanRing: TorusGeometry;
  verifier: OctahedronGeometry;
  shockRing: RingGeometry;
  packet: SphereGeometry;
  stars: BufferGeometry;
  /** By edge id: the curve a packet follows, its tube and the tube's material. */
  curves: Record<string, QuadraticBezierCurve3>;
  tubes: Record<string, TubeGeometry>;
  tubeMaterials: Record<string, MeshBasicMaterial>;

  coreMaterial: MeshPhysicalMaterial;
  rimMaterial: ShaderMaterial;
  wireMaterial: MeshBasicMaterial;
  gyroMaterial: MeshBasicMaterial;
  coderMaterials: MeshStandardMaterial[];
  coderRingMaterials: MeshBasicMaterial[];
  reviewerMaterial: MeshStandardMaterial;
  scanMaterial: MeshBasicMaterial;
  verifierMaterial: MeshStandardMaterial;
  shockMaterial: MeshBasicMaterial;
  packetMaterial: MeshBasicMaterial;
  starMaterial: PointsMaterial;

  /** Every geometry and material above, for disposal and tests. */
  all: (BufferGeometry | Material)[];
  dispose: () => void;
}

export function createHeroResources(): HeroResources {
  const planner = pipelineNode("planner");
  const reviewer = pipelineNode("reviewer");
  const verifier = pipelineNode("verifier");
  const coders = CODER_IDS.map(pipelineNode);

  const curves: Record<string, QuadraticBezierCurve3> = {};
  const tubes: Record<string, TubeGeometry> = {};
  const tubeMaterials: Record<string, MeshBasicMaterial> = {};
  for (const edge of PIPELINE_EDGES) {
    const from = new Vector3(...pipelineNode(edge.from).position);
    const to = new Vector3(...pipelineNode(edge.to).position);
    // Bow each path towards the viewer, and outwards from the centre line.
    const control = from.clone().lerp(to, 0.5);
    control.z += 0.9;
    control.y *= 1.25;
    curves[edge.id] = new QuadraticBezierCurve3(from, control, to);
    tubes[edge.id] = new TubeGeometry(curves[edge.id], 40, 0.012, 6, false);
    tubeMaterials[edge.id] = new MeshBasicMaterial({ color: "#64748b", transparent: true, opacity: 0.45 });
  }

  const random = seeded(7);
  const starPositions = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i += 1) {
    starPositions[i * 3] = (random() - 0.5) * 26;
    starPositions[i * 3 + 1] = (random() - 0.5) * 14;
    starPositions[i * 3 + 2] = -2 - random() * 12; // behind the pipeline
  }
  const stars = new BufferGeometry();
  stars.setAttribute("position", new BufferAttribute(starPositions, 3));

  const emissive = (color: string, flatShading = false) =>
    new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3, roughness: 0.35, metalness: 0.25, flatShading });

  const resources = {
    core: new IcosahedronGeometry(0.3, 2),
    shell: new IcosahedronGeometry(0.5, 1),
    rim: new SphereGeometry(0.62, 32, 32),
    gyroRing: new TorusGeometry(0.82, 0.01, 8, 64),
    coder: new DodecahedronGeometry(0.3, 0),
    coderRings: coders.map(() => new TorusGeometry(0.48, 0.022, 8, 64)),
    reviewer: new IcosahedronGeometry(0.36, 0),
    scanRing: new TorusGeometry(0.56, 0.014, 8, 64),
    verifier: new OctahedronGeometry(0.46, 0),
    shockRing: new RingGeometry(0.5, 0.56, 64),
    packet: new SphereGeometry(0.075, 12, 12),
    stars,
    curves,
    tubes,
    tubeMaterials,

    coreMaterial: new MeshPhysicalMaterial({
      color: planner.color,
      emissive: planner.color,
      emissiveIntensity: 0.9,
      roughness: 0.2,
      metalness: 0.1,
      clearcoat: 1,
    }),
    rimMaterial: new ShaderMaterial({
      uniforms: { uColor: { value: new Color(planner.color) }, uTime: { value: 0 }, uIntensity: { value: 0.9 } },
      vertexShader: FRESNEL_VERTEX,
      fragmentShader: FRESNEL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
    wireMaterial: new MeshBasicMaterial({ color: planner.color, wireframe: true, transparent: true, opacity: 0.35 }),
    gyroMaterial: new MeshBasicMaterial({ color: "#c4b5fd", transparent: true, opacity: 0.7 }),
    coderMaterials: coders.map((coder) => emissive(coder.color, true)),
    coderRingMaterials: coders.map((coder) => new MeshBasicMaterial({ color: coder.color, transparent: true, opacity: 0.9 })),
    reviewerMaterial: emissive(reviewer.color, true),
    scanMaterial: new MeshBasicMaterial({ color: reviewer.color, transparent: true, opacity: 0.85 }),
    verifierMaterial: emissive(verifier.color, true),
    shockMaterial: new MeshBasicMaterial({ color: verifier.color, transparent: true, opacity: 0, depthWrite: false }),
    packetMaterial: new MeshBasicMaterial({ color: "#e0f2fe" }),
    starMaterial: new PointsMaterial({ color: "#94a3b8", size: 0.045, sizeAttenuation: true, transparent: true, opacity: 0.7 }),
  };

  const all: (BufferGeometry | Material)[] = [
    resources.core,
    resources.shell,
    resources.rim,
    resources.gyroRing,
    resources.coder,
    ...resources.coderRings,
    resources.reviewer,
    resources.scanRing,
    resources.verifier,
    resources.shockRing,
    resources.packet,
    resources.stars,
    ...Object.values(tubes),
    ...Object.values(tubeMaterials),
    resources.coreMaterial,
    resources.rimMaterial,
    resources.wireMaterial,
    resources.gyroMaterial,
    ...resources.coderMaterials,
    ...resources.coderRingMaterials,
    resources.reviewerMaterial,
    resources.scanMaterial,
    resources.verifierMaterial,
    resources.shockMaterial,
    resources.packetMaterial,
    resources.starMaterial,
  ];
  return { ...resources, all, dispose: () => all.forEach((resource) => resource.dispose()) };
}
