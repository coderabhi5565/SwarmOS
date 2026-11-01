import { X } from "lucide-react";
import type { ReactNode } from "react";
import { formatDuration, formatTokens, humanize } from "@/components/execution/format";
import { RoleDot, ToneBadge, Unknown, Value, type Tone } from "@/components/execution/primitives";
import { Button } from "@/components/ui/button";
import { verificationRunsOf, type ExecutionState, type Invocation, type VerificationRun } from "@/domain/execution";
import { invocationsForNode, type VizModel, type VizNode } from "@/domain/visualization";
import { selectionNodeId, useViewStore } from "@/store/viewStore";
import { nodeBadges, ROLE_LABEL, statusLabel, statusTone } from "./presentation";

const CALL_TONE: Record<Invocation["status"], Tone> = {
  running: "live",
  succeeded: "completed",
  failed: "failed",
  skipped: "muted",
  interrupted: "cancelled",
};

const RUN_TONE: Record<VerificationRun["status"], Tone> = {
  running: "live",
  passed: "completed",
  failed: "failed",
  interrupted: "cancelled",
};

/** The selected node, in detail. Shared by the 2D and 3D views. */
export function NodeDetails({ state, model }: { state: ExecutionState; model: VizModel }) {
  const selectedId = useViewStore((store) => selectionNodeId(store.selection));
  const clearSelection = useViewStore((store) => store.clearSelection);
  const node = model.nodes.find((candidate) => candidate.id === selectedId) ?? null;

  return (
    <aside aria-label="Node details" aria-live="polite" className="min-w-0 rounded-lg border border-border/70 bg-card/40 p-3">
      {!node ? (
        <p className="text-sm text-muted-foreground">
          {selectedId
            ? "The selected node is not part of this run."
            : "Select a node in the graph to see its calls, attempts and results."}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <RoleDot role={node.role} className="mt-1.5" />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{ROLE_LABEL[node.role]}</p>
              <h3 className="truncate text-sm font-semibold" title={node.label}>
                {node.label}
              </h3>
              {node.title && <p className="text-xs text-muted-foreground">{node.title}</p>}
            </div>
            <Button variant="ghost" size="icon" className="size-7" aria-label="Close details" onClick={clearSelection}>
              <X aria-hidden="true" />
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <ToneBadge tone={statusTone(node)} pulse={node.active}>
              {statusLabel(node, model.finished)}
            </ToneBadge>
            {nodeBadges(node).map((badge) => (
              <ToneBadge key={badge} tone="muted">
                {badge}
              </ToneBadge>
            ))}
          </div>
          {!node.startRecorded && node.attempts > 0 && (
            <p className="text-xs text-muted-foreground">
              This trace records results but not start events, so when this work was running is unknown.
            </p>
          )}
          {node.kind === "step" && <StepFacts state={state} node={node} />}
          {node.kind === "runner" ? <RunnerRuns state={state} /> : <Calls calls={invocationsForNode(state, node)} />}
        </div>
      )}
    </aside>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="wrap-break-word">{children}</dd>
    </div>
  );
}

function StepFacts({ state, node }: { state: ExecutionState; node: VizNode }) {
  const step = state.plan?.steps[node.label];
  if (!step) return null;
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
      <Fact label="wave">{step.wave === null ? <Unknown /> : step.wave + 1}</Fact>
      <Fact label="depends on">
        {step.dependsOn === null ? (
          <Unknown />
        ) : step.dependsOn.length === 0 ? (
          "nothing"
        ) : (
          <span className="font-mono">{step.dependsOn.join(", ")}</span>
        )}
      </Fact>
      <Fact label="files">
        {/* An empty list may mean "writes none" or "not recorded": say only what is known. */}
        {step.targetFiles.length === 0 ? <Unknown>none listed</Unknown> : <span className="font-mono">{step.targetFiles.join(", ")}</span>}
      </Fact>
      <Fact label="attempts">{step.attempts}</Fact>
      {step.acceptanceCriteria.length > 0 && (
        <div className="col-span-2">
          <dt className="text-muted-foreground">acceptance criteria</dt>
          <dd>
            <ul className="list-disc space-y-0.5 pl-4">
              {step.acceptanceCriteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          </dd>
        </div>
      )}
      {step.lastError && (
        <div className="col-span-2">
          <dt className="text-muted-foreground">last error</dt>
          <dd className="wrap-break-word text-status-failed">{step.lastError}</dd>
        </div>
      )}
    </dl>
  );
}

function Calls({ calls }: { calls: Invocation[] }) {
  if (calls.length === 0) return <p className="text-xs text-muted-foreground">No model call recorded.</p>;
  return (
    <ol className="space-y-2" aria-label="Model calls">
      {calls.map((call, index) => (
        <li key={call.id} className="rounded-md border border-border/60 p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">
              {call.attempt !== null ? `Attempt ${call.attempt}` : `Call ${index + 1}`}
            </span>
            <ToneBadge tone={CALL_TONE[call.status]} pulse={call.status === "running"}>
              {call.status}
            </ToneBadge>
          </div>
          <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 font-mono">
            <Fact label="tier">
              <Value value={call.tier} />
            </Fact>
            <Fact label="model">
              <Value value={call.model} />
            </Fact>
            <Fact label="latency">
              <Value value={formatDuration(call.latencyMs)} missing={call.status === "running" ? "…" : undefined} />
            </Fact>
            <Fact label="tokens in/out">
              {call.inputTokens === null && call.outputTokens === null ? (
                <Unknown />
              ) : (
                `${formatTokens(call.inputTokens) ?? "?"} / ${formatTokens(call.outputTokens) ?? "?"}`
              )}
            </Fact>
          </dl>
          {call.error && (
            <p className="mt-1.5 wrap-break-word text-status-failed">
              {call.errorClass ? `${humanize(call.errorClass)}: ` : ""}
              {call.error}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

function RunnerRuns({ state }: { state: ExecutionState }) {
  const runs = verificationRunsOf(state);
  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted-foreground">
        Runs the task's read-only tests as a separate process. No model is involved.
      </p>
      {runs.length === 0 ? (
        <p className="text-muted-foreground">No verification has run.</p>
      ) : (
        <ol className="space-y-2" aria-label="Verification runs">
          {runs.map((run) => (
            <li key={run.id} className="flex items-center justify-between gap-2 rounded-md border border-border/60 p-2">
              <span>
                {run.diagnostic ? "Diagnostic run" : `Attempt ${run.attempt ?? "?"}`}
                <span className="font-mono text-muted-foreground">
                  {" · "}
                  {run.testsPassed === null && run.testsFailed === null
                    ? run.status === "running"
                      ? "running…"
                      : "results not recorded"
                    : `${run.testsPassed ?? "?"} passed, ${run.testsFailed ?? "?"} failed`}
                </span>
              </span>
              <ToneBadge tone={RUN_TONE[run.status]} pulse={run.status === "running"}>
                {run.status}
              </ToneBadge>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
