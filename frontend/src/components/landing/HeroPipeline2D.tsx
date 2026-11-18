import { cn } from "@/lib/utils";
import { PIPELINE_EDGES, PIPELINE_NODES, pipelineNode, type PipelineRole } from "./pipeline";

const ROLE_VAR: Record<PipelineRole, string> = {
  planner: "var(--agent-planner)",
  coder: "var(--agent-coder)",
  reviewer: "var(--agent-reviewer)",
  verifier: "var(--agent-verifier)",
};

const WIDTH = 132;
const HEIGHT = 44;

/** Two short lines for a long label, so it fits its box. */
function lines(label: string): string[] {
  const words = label.split(" ");
  if (label.length <= 14 || words.length < 2) return [label];
  const first = words.length > 2 ? words.slice(0, -2) : words.slice(0, 1);
  return [first.join(" "), words.slice(first.length).join(" ")];
}

/**
 * The pipeline as a static diagram: the hero when WebGL2 is unavailable,
 * the context is lost or reduced motion is on, and while the 3D scene
 * loads. Nothing moves, and no 3D code is needed to draw it.
 */
export function HeroPipeline2D({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 640 260"
      role="img"
      aria-label="SwarmOS pipeline: planner, a parallel wave of three coders, the reviewer evidence guard, then the deterministic verifier"
      data-testid="hero-pipeline-2d"
      className={cn("size-full", className)}
    >
      <g stroke="var(--border)" strokeWidth={1.5} fill="none">
        {PIPELINE_EDGES.map((edge) => {
          const [x1, y1] = pipelineNode(edge.from).point;
          const [x2, y2] = pipelineNode(edge.to).point;
          return <line key={edge.id} x1={x1 + WIDTH / 2 - 14} y1={y1} x2={x2 - WIDTH / 2 + 14} y2={y2} />;
        })}
      </g>
      {PIPELINE_NODES.map((node) => {
        const [x, y] = node.point;
        const text = lines(node.label);
        return (
          <g key={node.id}>
            <title>{`${node.label}: ${node.description}`}</title>
            <rect
              x={x - WIDTH / 2 + 14}
              y={y - HEIGHT / 2}
              width={WIDTH - 28}
              height={HEIGHT}
              rx={10}
              fill="color-mix(in oklch, var(--card) 80%, transparent)"
              stroke={ROLE_VAR[node.role]}
              strokeWidth={1.5}
            />
            <text x={x} y={y - (text.length - 1) * 6} textAnchor="middle" dominantBaseline="middle" fontSize={11} fill="var(--foreground)">
              {text.map((line, index) => (
                <tspan key={line} x={x} dy={index === 0 ? 0 : 13}>
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        );
      })}
      <text x={250} y={250} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)">
        parallel wave
      </text>
    </svg>
  );
}
