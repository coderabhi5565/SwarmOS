import { isActiveExperiment } from "@/api/benchmarkQueries";
import type { BenchmarkExperimentStatus } from "@/api/types";
import { ToneBadge, type Tone } from "@/components/execution/primitives";

const STATUS: Record<BenchmarkExperimentStatus, { tone: Tone; label: string }> = {
  queued: { tone: "live", label: "queued" },
  running: { tone: "live", label: "running" },
  completed: { tone: "completed", label: "completed" },
  partial: { tone: "findings", label: "partial" },
  cancelled: { tone: "cancelled", label: "cancelled" },
  failed: { tone: "failed", label: "failed" },
  interrupted: { tone: "cancelled", label: "interrupted" },
};

/** An experiment's status; it pulses only while the experiment is active. */
export function ExperimentStatusBadge({ status }: { status: BenchmarkExperimentStatus }) {
  const { tone, label } = STATUS[status];
  return (
    <ToneBadge tone={tone} pulse={isActiveExperiment(status)}>
      {label}
    </ToneBadge>
  );
}

/**
 * Whether the results came from the scripted demo fixture or a real model.
 * Scripted results describe the orchestration, never a model's ability.
 */
export function ProvenanceBadge({ scripted }: { scripted: boolean }) {
  return scripted ? (
    <ToneBadge tone="findings" pulse={false}>
      scripted provider
    </ToneBadge>
  ) : (
    <ToneBadge tone="muted" pulse={false}>
      real model
    </ToneBadge>
  );
}
