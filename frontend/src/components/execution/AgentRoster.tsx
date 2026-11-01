import type { AgentRole, AgentStatus, ExecutionState, RunnerNode } from "@/domain/execution";
import { invocationsFor, lifecycleRecorded, verificationRunsOf } from "@/domain/execution";
import { cn } from "@/lib/utils";
import { RoleDot, Section, ToneBadge, type Tone } from "./primitives";

const AGENT_TONE: Record<AgentStatus, Tone> = {
  idle: "muted",
  running: "live",
  done: "completed",
  failed: "failed",
  skipped: "muted",
  interrupted: "cancelled",
};

const RUNNER_TONE: Record<RunnerNode["status"], Tone> = {
  idle: "muted",
  running: "live",
  passed: "completed",
  failed: "failed",
  interrupted: "cancelled",
};

const AGENT_TEXT: Record<AgentRole, { name: string; job: string }> = {
  planner: { name: "Planner", job: "Plans steps, dependencies and waves" },
  coder: { name: "Coder", job: "Implements plan steps" },
  reviewer: { name: "Reviewer", job: "Accepts or rejects with evidence" },
};

const ROLES: AgentRole[] = ["planner", "coder", "reviewer"];

export function AgentRoster({ state }: { state: ExecutionState }) {
  const runs = verificationRunsOf(state);
  return (
    <Section
      id="agents"
      title="Agents and runner"
      description={
        lifecycleRecorded(state) || state.invocationOrder.length === 0
          ? "Three model agents and the deterministic verification runner."
          : "This trace predates lifecycle events: calls appear when they finish, never as running."
      }
    >
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {ROLES.map((role) => {
          const agent = state.agents[role];
          const calls = invocationsFor(state, role);
          const failed = calls.filter((call) => call.status === "failed").length;
          return (
            <li key={role} className="rounded-lg border border-border/70 bg-card/40 p-3" aria-label={`${AGENT_TEXT[role].name} agent`}>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-medium">
                  <RoleDot role={role} />
                  {AGENT_TEXT[role].name}
                </span>
                <ToneBadge tone={AGENT_TONE[agent.status]}>
                  {agent.status === "running" && agent.activeInvocationIds.length > 1
                    ? `${agent.activeInvocationIds.length} running`
                    : agent.status}
                </ToneBadge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{AGENT_TEXT[role].job}</p>
              <p className="mt-2 font-mono text-xs text-muted-foreground">
                {calls.length} call{calls.length === 1 ? "" : "s"}
                {failed > 0 && <span className="text-status-failed"> · {failed} failed</span>}
              </p>
            </li>
          );
        })}
        <li
          className={cn("rounded-lg border border-dashed border-agent-verifier/40 bg-card/20 p-3")}
          aria-label="Verification runner"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 font-medium">
              <RoleDot role="verifier" />
              Verifier
            </span>
            <ToneBadge tone={RUNNER_TONE[state.verifier.status]}>{state.verifier.status}</ToneBadge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Deterministic test runner, not a model</p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            {runs.length} run{runs.length === 1 ? "" : "s"}
          </p>
        </li>
      </ul>
    </Section>
  );
}
