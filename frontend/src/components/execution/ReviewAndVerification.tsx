import type { ExecutionState, ReviewRound, VerificationStatus } from "@/domain/execution";
import { verificationRunsOf } from "@/domain/execution";
import { formatDuration } from "./format";
import { EmptyLine, Section, ToneBadge, Value, type Tone } from "./primitives";

function verdictBadge(round: ReviewRound) {
  if (round.invalid) return <ToneBadge tone="invalid">invalid review</ToneBadge>;
  if (round.verdict === "approve") return <ToneBadge tone="completed">approved</ToneBadge>;
  if (round.verdict === "request_changes") return <ToneBadge tone="findings">changes requested</ToneBadge>;
  return <ToneBadge tone="muted">verdict not recorded</ToneBadge>;
}

const SEVERITY_CLASS: Record<string, string> = {
  blocker: "text-status-failed",
  major: "text-status-findings",
  minor: "text-muted-foreground",
  nit: "text-muted-foreground",
};

export function ReviewRounds({ state }: { state: ExecutionState }) {
  return (
    <Section
      id="review"
      title="Review"
      description="Each review round, its verdict, and the findings behind a rejection."
    >
      {state.reviews.length === 0 ? (
        <EmptyLine>No review has happened.</EmptyLine>
      ) : (
        <ol className="space-y-3">
          {state.reviews.map((round) => (
            <li key={round.index} className="rounded-lg border border-border/70 bg-card/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  Round {round.index}
                  {round.rejection !== null && (
                    <span className="font-mono text-xs text-muted-foreground"> · rejection {round.rejection}</span>
                  )}
                </span>
                {verdictBadge(round)}
              </div>
              {round.invalid && (
                <p className="mt-2 text-xs text-status-invalid">
                  The reviewer rejected without the evidence the review guard requires. The run stopped
                  here; this is not an approval.
                </p>
              )}
              {round.findings.length > 0 && (
                <ul className="mt-2 space-y-1.5">
                  {round.findings.map((finding, index) => (
                    <li key={index} className="text-xs">
                      <span className={`font-mono uppercase ${SEVERITY_CLASS[finding.severity] ?? ""}`}>{finding.severity}</span>
                      {finding.step_id && <span className="font-mono text-muted-foreground"> · {finding.step_id}</span>}
                      <span className="block wrap-break-word text-foreground/85">{finding.message}</span>
                    </li>
                  ))}
                </ul>
              )}
              {round.withheldBlockers.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {round.withheldBlockers.length} unsupported blocker
                  {round.withheldBlockers.length > 1 ? "s were" : " was"} withheld from the coder.
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

const RUN_TONE: Record<VerificationStatus, Tone> = {
  running: "live",
  passed: "completed",
  failed: "failed",
  interrupted: "cancelled",
};

export function VerificationRuns({ state }: { state: ExecutionState }) {
  const runs = verificationRunsOf(state);
  return (
    <Section
      id="verification"
      title="Verification"
      description="Real test runs by the deterministic runner. Diagnostic runs record evidence and never change the status."
    >
      {runs.length === 0 ? (
        <EmptyLine>No verification has run.</EmptyLine>
      ) : (
        <ol className="space-y-3">
          {runs.map((run) => (
            <li key={run.id} className="rounded-lg border border-border/70 bg-card/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {run.diagnostic ? "Diagnostic run" : `Attempt ${run.attempt ?? "?"}`}
                </span>
                <ToneBadge tone={RUN_TONE[run.status]}>{run.status}</ToneBadge>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">tests passed</dt>
                  <dd><Value value={run.testsPassed} missing={run.status === "running" ? "…" : "not recorded"} /></dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">tests failed</dt>
                  <dd><Value value={run.testsFailed} missing={run.status === "running" ? "…" : "not recorded"} /></dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">exit code</dt>
                  <dd><Value value={run.exitCode} missing={run.status === "running" ? "…" : "not recorded"} /></dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">duration</dt>
                  <dd><Value value={formatDuration(run.durationMs)} missing={run.status === "running" ? "…" : "not recorded"} /></dd>
                </div>
              </dl>
              {run.command && <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">$ {run.command}</p>}
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
