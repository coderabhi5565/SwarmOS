import "@xyflow/react/dist/style.css";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeHandle,
  type NodeProps,
} from "@xyflow/react";
import { Bot, FlaskConical, GitBranch } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { memo, useCallback, useEffect, useMemo } from "react";
import { RoleDot, ToneBadge } from "@/components/execution/primitives";
import type { VizEdge, VizModel, VizNode } from "@/domain/visualization";
import { cn } from "@/lib/utils";
import { selectionFromNodeId, selectionNodeId, useViewStore } from "@/store/viewStore";
import { edgeDescription, nodeBadges, nodeDescription, statusLabel, statusTone } from "./presentation";

/** Grid spacing and fixed node sizes: layout never depends on measurement. */
const COLUMN_WIDTH = 250;
const ROW_HEIGHT = 124;
const SIZE: Record<VizNode["kind"], { width: number; height: number }> = {
  agent: { width: 176, height: 76 },
  step: { width: 200, height: 100 },
  runner: { width: 184, height: 84 },
};

type GraphNodeData = { node: VizNode; finished: boolean };
type GraphNode = Node<GraphNodeData, VizNode["kind"]>;

const EDGE_COLOR: Record<VizEdge["kind"], string> = {
  flow: "var(--muted-foreground)",
  dependency: "var(--brand-cyan)",
  revision: "var(--status-findings)",
  repair: "var(--status-failed)",
};

/**
 * The run as a 2D graph: planner, one column per wave of coder steps,
 * reviewer, then the deterministic verification runner. No WebGL needed.
 */
export function ExecutionGraph2D({ model, live }: { model: VizModel; live: boolean }) {
  return (
    <ReactFlowProvider>
      <Graph model={model} live={live} />
    </ReactFlowProvider>
  );
}

function Graph({ model, live }: { model: VizModel; live: boolean }) {
  const selectedId = useViewStore((state) => selectionNodeId(state.selection));
  const select = useViewStore((state) => state.select);
  const clearSelection = useViewStore((state) => state.clearSelection);
  const followLive = useViewStore((state) => state.followLive);
  const reducedMotion = useReducedMotion() ?? false;

  const nodes = useMemo(
    () => model.nodes.map((node) => toFlowNode(node, model.finished, node.id === selectedId)),
    [model.nodes, model.finished, selectedId],
  );
  const edges = useMemo(() => model.edges.map((edge) => toFlowEdge(edge, model, !reducedMotion)), [model, reducedMotion]);

  const onNodesChange = useCallback(
    (changes: NodeChange<GraphNode>[]) => {
      // Keyboard selection (Enter on a focused node) arrives as a change.
      const picked = changes.find((change) => change.type === "select" && change.selected);
      if (picked && picked.type === "select") select(selectionFromNodeId(picked.id));
    },
    [select],
  );

  return (
    <div className="execution-graph size-full" data-testid="execution-graph-2d">
      <ReactFlow<GraphNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => select(selectionFromNodeId(node.id))}
        onPaneClick={clearSelection}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
        minZoom={0.2}
        maxZoom={2}
        colorMode="dark"
        ariaLabelConfig={{ "node.a11yDescription.default": "Press Enter to show this node's details." }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
        <Controls showInteractive={false} position="bottom-left" />
        <FollowActive model={model} enabled={live && followLive} animate={!reducedMotion} />
      </ReactFlow>
    </div>
  );
}

/** While following a live run, keep the work that is running in view. */
function FollowActive({ model, enabled, animate }: { model: VizModel; enabled: boolean; animate: boolean }) {
  const { fitView } = useReactFlow();
  const activeKey = model.nodes
    .filter((node) => node.active)
    .map((node) => node.id)
    .join(" ");
  useEffect(() => {
    if (!enabled || !activeKey) return;
    void fitView({
      nodes: activeKey.split(" ").map((id) => ({ id })),
      padding: 0.8,
      maxZoom: 1.1,
      duration: animate ? 400 : 0,
    });
  }, [enabled, activeKey, animate, fitView]);
  return null;
}

/** Converted nodes are cached per model node, so unchanged nodes keep their identity. */
const flowNodes = new WeakMap<VizNode, { selected: boolean; finished: boolean; node: GraphNode }>();

function toFlowNode(node: VizNode, finished: boolean, selected: boolean): GraphNode {
  const cached = flowNodes.get(node);
  if (cached && cached.selected === selected && cached.finished === finished) return cached.node;
  const { width, height } = SIZE[node.kind];
  const flowNode: GraphNode = {
    id: node.id,
    type: node.kind,
    position: { x: node.column * COLUMN_WIDTH, y: node.row * ROW_HEIGHT - height / 2 },
    width,
    height,
    handles: handlesFor(node.kind, width, height),
    selected,
    data: { node, finished },
    ariaLabel: nodeDescription(node, finished),
  };
  flowNodes.set(node, { selected, finished, node: flowNode });
  return flowNode;
}

const flowEdges = new WeakMap<VizEdge, { motion: boolean; edge: Edge }>();

function toFlowEdge(edge: VizEdge, model: VizModel, motion: boolean): Edge {
  const cached = flowEdges.get(edge);
  if (cached && cached.motion === motion) return cached.edge;
  const flowEdge = buildFlowEdge(edge, model, motion);
  flowEdges.set(edge, { motion, edge: flowEdge });
  return flowEdge;
}

function buildFlowEdge(edge: VizEdge, model: VizModel, motion: boolean): Edge {
  const back = edge.kind === "revision" || edge.kind === "repair";
  const color = EDGE_COLOR[edge.kind];
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: back ? "back-out" : "out",
    targetHandle: back ? "back-in" : "in",
    type: back ? "smoothstep" : "default",
    animated: edge.active && motion,
    label: back ? `${edge.kind === "revision" ? "revise" : "repair"}${edge.count > 1 ? ` ×${edge.count}` : ""}` : undefined,
    labelStyle: { fill: color, fontSize: 11, fontFamily: "var(--font-mono)" },
    labelBgStyle: { fill: "var(--background)" },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
    style: {
      stroke: color,
      strokeWidth: edge.active ? 2.5 : edge.kind === "flow" ? 1.25 : 1.75,
      strokeDasharray: back ? "6 4" : undefined,
      opacity: edge.kind === "flow" && !edge.active ? 0.55 : 1,
    },
    ariaLabel: edgeDescription(edge, model),
    focusable: false,
  };
}

const HANDLE = 6;

/** Handle geometry declared up front, so edges never wait for DOM measurement. */
function handlesFor(kind: VizNode["kind"], width: number, height: number): NodeHandle[] {
  const box = { width: HANDLE, height: HANDLE };
  const middle = height / 2 - HANDLE / 2;
  return [
    { id: "in", type: "target", position: Position.Left, x: -HANDLE / 2, y: middle, ...box },
    { id: "out", type: "source", position: Position.Right, x: width - HANDLE / 2, y: middle, ...box },
    kind === "step"
      ? { id: "back-in", type: "target", position: Position.Top, x: width / 2 - HANDLE / 2, y: -HANDLE / 2, ...box }
      : { id: "back-out", type: "source", position: Position.Top, x: width / 2 - HANDLE / 2, y: -HANDLE / 2, ...box },
  ];
}

const HANDLE_CLASS = "!size-1.5 !min-w-0 !border-0 !bg-transparent";

function Handles({ kind }: { kind: VizNode["kind"] }) {
  return (
    <>
      <Handle type="target" position={Position.Left} id="in" isConnectable={false} className={HANDLE_CLASS} />
      <Handle type="source" position={Position.Right} id="out" isConnectable={false} className={HANDLE_CLASS} />
      {kind === "step" ? (
        <Handle type="target" position={Position.Top} id="back-in" isConnectable={false} className={HANDLE_CLASS} />
      ) : (
        <Handle type="source" position={Position.Top} id="back-out" isConnectable={false} className={HANDLE_CLASS} />
      )}
    </>
  );
}

function NodeFrame({
  data,
  selected,
  className,
  icon,
  caption,
}: {
  data: GraphNodeData;
  selected: boolean;
  className?: string;
  icon: React.ReactNode;
  caption: string;
}) {
  const { node, finished } = data;
  const badges = nodeBadges(node);
  return (
    <div
      className={cn(
        "flex size-full flex-col gap-1.5 overflow-hidden border bg-card/90 px-3 py-2 text-left shadow-sm backdrop-blur transition-colors",
        node.active ? "border-status-live/70 shadow-[0_0_0_3px] shadow-status-live/15" : "border-border",
        node.status === "failed" && "border-status-failed/60",
        selected && "ring-2 ring-ring",
        className,
      )}
    >
      <Handles kind={node.kind} />
      <div className="flex min-w-0 items-center gap-1.5">
        <RoleDot role={node.role} />
        <span className="truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{caption}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">{icon}</span>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-sm font-medium" title={node.title ?? node.label}>
          {node.label}
        </span>
        <ToneBadge tone={statusTone(node)} pulse={node.active}>
          {statusLabel(node, finished)}
        </ToneBadge>
      </div>
      {badges.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-1 overflow-hidden">
          {badges.map((badge) => (
            <span key={badge} className="rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">
              {badge}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const AgentNode = memo(function AgentNode({ data, selected }: NodeProps<GraphNode>) {
  return <NodeFrame data={data} selected={selected} className="rounded-2xl" icon={<Bot className="size-3.5" />} caption="agent" />;
});

const StepNode = memo(function StepNode({ data, selected }: NodeProps<GraphNode>) {
  const wave = data.node.wave === null ? "coder" : `coder · wave ${data.node.wave + 1}`;
  return <NodeFrame data={data} selected={selected} className="rounded-lg" icon={<GitBranch className="size-3.5" />} caption={wave} />;
});

/** Deterministic, not an agent: squared off with a dashed frame. */
const RunnerNode = memo(function RunnerNode({ data, selected }: NodeProps<GraphNode>) {
  return (
    <NodeFrame
      data={data}
      selected={selected}
      className="rounded-none border-dashed"
      icon={<FlaskConical className="size-3.5" />}
      caption="deterministic runner"
    />
  );
});

const NODE_TYPES = { agent: AgentNode, step: StepNode, runner: RunnerNode };
