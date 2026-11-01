/**
 * Presentation of one normalised event for the timeline: a title, an actor,
 * a tone and a category. Pure; reads only what the event carries.
 */
import type { NormalizedEvent } from "@/domain/execution";
import type { ActorRole, Tone } from "./primitives";

export type EventCategory = "agents" | "orchestration" | "problems";

export interface EventPresentation {
  title: string;
  detail: string | null;
  actor: ActorRole | "orchestrator" | null;
  tone: Tone;
  category: EventCategory;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function describeEvent(event: NormalizedEvent): EventPresentation {
  switch (event.type) {
    case "run_started":
      return { title: "Run started", detail: event.provider ? `provider ${event.provider}` : null, actor: "orchestrator", tone: "live", category: "orchestration" };
    case "planner_dispatched":
      return { title: "Planner dispatched", detail: event.tier ? `${event.tier} tier` : null, actor: "orchestrator", tone: "muted", category: "orchestration" };
    case "plan_ready":
      return {
        title: event.source === "recipe" ? "Plan supplied by the recipe" : "Plan accepted",
        detail: `${plural(event.stepIds.length, "step")} in ${plural(event.waves.length, "wave")}`,
        actor: event.source === "recipe" ? "orchestrator" : "planner",
        tone: "completed",
        category: "orchestration",
      };
    case "coding_dispatched":
      return {
        title: `Dispatched ${plural(event.steps.length, "coding step")}${event.mode && event.mode !== "initial" ? ` (${event.mode})` : ""}`,
        detail: `${event.steps.join(", ")}${event.parallel ? " · parallel" : ""}${event.tier ? ` · ${event.tier} tier` : ""}`,
        actor: "orchestrator",
        tone: "muted",
        category: "orchestration",
      };
    case "wave_merged":
      return {
        title: event.rejected.length > 0 ? "Merge rejected conflicting steps" : `Merged ${plural(event.accepted.length, "step")}`,
        detail: [event.accepted.join(", "), event.rejected.length > 0 ? `rejected: ${event.rejected.join(", ")}` : ""].filter(Boolean).join(" · ") || null,
        actor: "orchestrator",
        tone: event.rejected.length > 0 ? "failed" : "completed",
        category: "orchestration",
      };
    case "agent_started":
      return {
        title: `${capitalize(event.role)} started`,
        detail: [event.stepId, event.attempt !== null ? `attempt ${event.attempt}` : null, event.model].filter(Boolean).join(" · ") || null,
        actor: event.role,
        tone: "live",
        category: "agents",
      };
    case "agent_finished":
      return {
        title: `${capitalize(event.role)} ${event.status}`,
        detail: [event.stepId, event.attempt !== null ? `attempt ${event.attempt}` : null, event.errorClass].filter(Boolean).join(" · ") || null,
        actor: event.role,
        tone: event.status === "succeeded" ? "completed" : event.status === "failed" ? "failed" : "muted",
        category: event.status === "failed" ? "problems" : "agents",
      };
    case "verification_started":
      return { title: event.diagnostic ? "Diagnostic verification started" : "Verification started", detail: event.command, actor: "verifier", tone: "live", category: "agents" };
    case "verification_finished":
      return {
        title: `${event.diagnostic ? "Diagnostic verification" : "Verification"} ${event.passed ? "passed" : "failed"}`,
        detail: event.testsPassed !== null ? `${event.testsPassed} passed · ${event.testsFailed ?? 0} failed` : null,
        actor: "verifier",
        tone: event.passed ? "completed" : "failed",
        category: event.passed ? "agents" : "problems",
      };
    case "review_rejected":
      return {
        title: "Review requested changes",
        detail: `${plural(event.findings.length, "finding")}${event.steps.length > 0 ? ` · ${event.steps.join(", ")}` : ""}`,
        actor: "reviewer",
        tone: "findings",
        category: "problems",
      };
    case "failure":
      return {
        title: event.message || "Failure",
        detail: [event.errorClass, event.stepIds.join(", ")].filter(Boolean).join(" · ") || null,
        actor: event.role,
        tone: event.errorClass === "review_invalid" ? "invalid" : "failed",
        category: "problems",
      };
    case "retry":
      return {
        title: event.scope === "steps" ? `Retrying ${event.steps.join(", ")}` : `Retrying ${event.role ?? "call"}`,
        detail: event.category ?? (event.delaySeconds !== null ? `after ${event.delaySeconds}s` : null),
        actor: event.scope === "steps" ? "orchestrator" : event.role,
        tone: "findings",
        category: "problems",
      };
    case "repair":
      return { title: "Structured-output repair requested", detail: event.stepId, actor: event.role, tone: "findings", category: "problems" };
    case "escalation":
      return {
        title: event.available ? `Escalated to the ${event.toTier ?? "strong"} tier` : "Escalation unavailable",
        detail: event.model ?? event.reason,
        actor: "orchestrator",
        tone: event.available ? "findings" : "failed",
        category: "orchestration",
      };
    case "budget":
      return { title: "Call refused by the budget", detail: event.reason, actor: event.role, tone: "failed", category: "problems" };
    case "provider_error":
      return { title: "Provider error", detail: [event.category, event.retryable ? "retryable" : null].filter(Boolean).join(" · ") || null, actor: event.role, tone: "failed", category: "problems" };
    case "warning":
      return { title: event.message || "Warning", detail: event.code, actor: "orchestrator", tone: "findings", category: "problems" };
    case "run_finished":
      return { title: `Run finished: ${event.status?.replace(/_/g, " ") ?? "unknown"}`, detail: event.error, actor: "orchestrator", tone: event.status === "completed" ? "completed" : "muted", category: "orchestration" };
    case "unknown":
      return { title: `Unrecognised event (${event.rawKind})`, detail: event.message || null, actor: null, tone: "muted", category: "orchestration" };
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
