import type { ExecutionState, PlanStepNode, StepStatus } from "@/domain/execution";
import { stepsByWave } from "@/domain/execution";
import { EmptyLine, Section, ToneBadge, Unknown, type Tone } from "./primitives";

const STEP_TONE: Record<StepStatus, Tone> = {
  pending: "muted",
  dispatched: "muted",
  running: "live",
  coded: "findings",
  merged: "completed",
  failed: "failed",
  interrupted: "cancelled",
};

const STEP_LABEL: Record<StepStatus, string> = {
  pending: "pending",
  dispatched: "queued",
  running: "running",
  coded: "awaiting merge",
  merged: "merged",
  failed: "failed",
  interrupted: "interrupted",
};

const SOURCE_TEXT = {
  planner: "Planned by the planner model.",
  recipe: "Plan supplied by the catalog recipe; the planner was not called.",
  record: "Plan taken from the stored run record.",
} as const;

export function PlanWaves({ state }: { state: ExecutionState }) {
  const plan = state.plan;
  if (!plan) {
    return (
      <Section id="plan" title="Plan">
        <EmptyLine>No plan has been recorded for this run yet.</EmptyLine>
      </Section>
    );
  }
  const waves = stepsByWave(state);
  return (
    <Section
      id="plan"
      title="Plan and execution waves"
      description={`${SOURCE_TEXT[plan.source]} Steps in one wave are independent and may run in parallel.`}
    >
      {!plan.dependenciesKnown && (
        <p className="mb-3 rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
          Step dependencies were not recorded for this run, so only the waves are shown.
        </p>
      )}
      <ol className="flex flex-col gap-4 lg:flex-row lg:items-start">
        {waves.map((steps, index) => (
          <li key={index} className="min-w-0 flex-1">
            <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              {index < plan.waves.length ? `Wave ${index + 1}` : "Not placed in a wave"}
              {steps.length > 1 && <span className="text-brand-cyan"> · parallel</span>}
            </p>
            <ul className="space-y-2">
              {steps.map((step) => (
                <StepCard key={step.id} step={step} />
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {plan.assumptions.length > 0 && (
        <details className="mt-4 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Assumptions ({plan.assumptions.length})</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {plan.assumptions.map((assumption, index) => (
              <li key={index}>{assumption}</li>
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}

function StepCard({ step }: { step: PlanStepNode }) {
  return (
    <li className="rounded-lg border border-border/70 bg-card/40 p-3" aria-label={`Step ${step.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs text-brand-cyan">{step.id}</p>
          <p className="text-sm font-medium">{step.title ?? <Unknown>title not recorded</Unknown>}</p>
        </div>
        <ToneBadge tone={STEP_TONE[step.status]}>{STEP_LABEL[step.status]}</ToneBadge>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {step.dependsOn === null ? (
          <Unknown>dependencies not recorded</Unknown>
        ) : step.dependsOn.length === 0 ? (
          "No dependencies"
        ) : (
          <>
            After <span className="font-mono text-foreground/80">{step.dependsOn.join(", ")}</span>
          </>
        )}
      </p>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
        {step.attempts > 0 ? `attempt ${step.attempts}` : "not dispatched"}
        {step.revisionsRequested > 0 && ` · ${step.revisionsRequested} revision${step.revisionsRequested > 1 ? "s" : ""} requested`}
        {step.targetFiles.length > 0 && ` · ${step.targetFiles.join(", ")}`}
      </p>
      {step.lastError && step.status === "failed" && (
        <p className="mt-2 line-clamp-3 wrap-break-word text-xs text-status-failed">{step.lastError}</p>
      )}
    </li>
  );
}
