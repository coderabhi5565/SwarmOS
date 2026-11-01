import type { ReactNode } from "react";
import type { RunStatus } from "@/api/types";
import { RunStatusBadge } from "@/components/run/RunStatusBadge";
import type { ExecutionState, Phase } from "@/domain/execution";
import { runDurationMs, usageTotals } from "@/domain/execution";
import { formatDuration, formatTokens, formatUsd } from "./format";
import { EmptyLine, RoleDot, Section, ToneBadge, Unknown, Value } from "./primitives";

const PHASE_TEXT: Record<Phase, string> = {
  not_started: "Waiting to start",
  planning: "Planning",
  coding: "Coding",
  reviewing: "Reviewing",
  verifying: "Verifying",
  finished: "Finished",
};

/** The run's outcome, or the phase it is in while live. */
export function RunOutcome({ state, recordStatus }: { state: ExecutionState; recordStatus: RunStatus | null }) {
  const outcome = state.outcome;
  const status = outcome?.status ?? state.status ?? recordStatus;
  return (
    <div className="glass flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl p-4 sm:p-5" aria-live="polite">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          {outcome ? "Outcome" : "Phase"}
        </p>
        <div className="mt-1 flex items-center gap-2">
          {status ? <RunStatusBadge status={status} /> : <ToneBadge tone="muted">unknown</ToneBadge>}
          {!outcome && <span className="text-sm">{PHASE_TEXT[state.phase]}</span>}
        </div>
      </div>
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Duration</p>
        <p className="mt-1 font-mono text-sm">
          <Value value={formatDuration(runDurationMs(state))} missing={outcome ? "not recorded" : "in progress"} />
        </p>
      </div>
      {outcome?.error && (
        <p className="min-w-0 flex-1 basis-64 text-sm text-status-failed wrap-break-word">{outcome.error}</p>
      )}
      {outcome?.source === "record" && (
        <p className="basis-full text-xs text-muted-foreground">
          The trace ended without a run_finished event; this outcome comes from the stored run record.
        </p>
      )}
      {outcome?.recovered && (
        <p className="basis-full text-xs text-muted-foreground">The server restarted during this run; it was closed at startup.</p>
      )}
    </div>
  );
}

export function UsagePanel({ state }: { state: ExecutionState }) {
  const usage = usageTotals(state);
  const limits = state.budget.limits;
  const ledger = state.budget.ledger;
  const revisionRounds = state.dispatches.filter((d) => d.mode === "revision").length;
  const repairRounds = state.dispatches.filter((d) => d.mode === "repair").length;

  const rows: [string, ReactNode][] = [
    [
      "Model calls",
      <>
        {usage.finishedCalls}
        {limits && <span className="text-muted-foreground"> / {limits.max_agent_calls} allowed</span>}
        {usage.failedCalls > 0 && <span className="text-status-failed"> · {usage.failedCalls} failed</span>}
      </>,
    ],
    [
      "Tokens in / out",
      usage.inputTokens === null ? (
        <Unknown>{usage.finishedCalls === 0 ? "no calls yet" : "not reported by the provider"}</Unknown>
      ) : (
        `${formatTokens(usage.inputTokens)} / ${formatTokens(usage.outputTokens)}`
      ),
    ],
    [
      "Cost",
      ledger?.monetary_enforced ? (
        <>
          {formatUsd(ledger.spent_usd)}
          <span className="text-muted-foreground"> of {formatUsd(ledger.max_usd)}</span>
        </>
      ) : (
        <Unknown>not metered (no token pricing)</Unknown>
      ),
    ],
    [
      "Wall clock",
      ledger ? (
        <>
          {formatDuration(ledger.elapsed_seconds * 1000)}
          {limits && <span className="text-muted-foreground"> / {limits.max_wall_seconds} s allowed</span>}
        </>
      ) : (
        <Unknown>{limits ? `limit ${limits.max_wall_seconds} s; usage not reported yet` : "not reported"}</Unknown>
      ),
    ],
    ["Model tier", `${state.tier}${state.escalations.length > 0 ? ` · ${state.escalations.length} escalation${state.escalations.length > 1 ? "s" : ""}` : ""}`],
    [
      "Retries · revisions · repairs",
      `${state.retries.length} · ${revisionRounds}${limits ? ` of ${limits.max_revisions}` : ""} · ${repairRounds}`,
    ],
  ];

  return (
    <Section id="budget" title="Budget and usage" description="Limits and what the run actually consumed, as reported by the backend.">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map(([term, value]) => (
          <div key={term} className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1.5">
            <dt className="text-xs text-muted-foreground">{term}</dt>
            <dd className="text-right font-mono text-xs">{value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

export function IssuesPanel({ state }: { state: ExecutionState }) {
  const { failures, warnings, providerErrors, budget, integrity } = state;
  const empty =
    failures.length + warnings.length + providerErrors.length + budget.refusals.length === 0 &&
    integrity.missingSeqs.length === 0 &&
    integrity.unknownKinds.length === 0;
  return (
    <Section id="issues" title="Failures and warnings" description="Everything the trace recorded as going wrong.">
      {empty ? (
        <EmptyLine>No failures, warnings or refusals recorded.</EmptyLine>
      ) : (
        <ul className="space-y-2">
          {failures.map((failure) => (
            <li key={`f${failure.seq}`} className="rounded-md border border-status-failed/25 bg-status-failed/5 p-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                {failure.role && <RoleDot role={failure.role} />}
                <span className="font-medium text-foreground">{failure.message || "Failure"}</span>
                {failure.errorClass && <span className="font-mono text-status-failed">{failure.errorClass}</span>}
                <span className="font-mono text-muted-foreground">
                  #{failure.seq}
                  {failure.stepIds.length > 0 && ` · ${failure.stepIds.join(", ")}`}
                  {failure.attempt !== null && ` · attempt ${failure.attempt}`}
                </span>
              </div>
              <p className="mt-1 text-muted-foreground wrap-break-word">{failure.error}</p>
            </li>
          ))}
          {budget.refusals.map((refusal) => (
            <li key={`b${refusal.seq}`} className="rounded-md border border-status-failed/25 p-2.5 text-xs">
              <span className="font-medium">Call refused</span>
              <span className="font-mono text-muted-foreground"> #{refusal.seq} · {refusal.role ?? "?"} · {refusal.category}</span>
              {refusal.reason && <p className="mt-1 text-muted-foreground">{refusal.reason}</p>}
            </li>
          ))}
          {providerErrors.map((error) => (
            <li key={`p${error.seq}`} className="rounded-md border border-border/60 p-2.5 text-xs">
              <span className="font-medium">Provider error</span>
              <span className="font-mono text-muted-foreground"> #{error.seq} · {error.category}</span>
              {error.error && <p className="mt-1 text-muted-foreground wrap-break-word">{error.error}</p>}
            </li>
          ))}
          {warnings.map((warning) => (
            <li key={`w${warning.seq}`} className="rounded-md border border-status-findings/25 p-2.5 text-xs">
              <span className="font-medium text-status-findings">{warning.message}</span>
            </li>
          ))}
          {integrity.missingSeqs.length > 0 && (
            <li className="rounded-md border border-border/60 p-2.5 text-xs text-muted-foreground">
              Trace gap: events {integrity.missingSeqs.join(", ")} have not arrived.
            </li>
          )}
          {integrity.unknownKinds.length > 0 && (
            <li className="rounded-md border border-border/60 p-2.5 text-xs text-muted-foreground">
              Events this client does not recognise: {integrity.unknownKinds.join(", ")}.
            </li>
          )}
        </ul>
      )}
    </Section>
  );
}
