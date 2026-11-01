/**
 * Run status vocabulary for the new UI, keyed by the generated RunStatus.
 * Each map is exhaustive, so a status added to the backend fails the type
 * check as soon as the API types are regenerated.
 */
import type { RunStatus } from "@/api/types";

export type StatusTone = "live" | "completed" | "findings" | "invalid" | "failed" | "cancelled";

export const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "queued",
  running: "running",
  completed: "completed",
  completed_with_findings: "completed with findings",
  review_invalid: "invalid review",
  failed: "failed",
  cancelled: "cancelled",
  budget_exceeded: "budget exceeded",
  limit_exceeded: "call limit reached",
  timed_out: "timed out",
};

export const STATUS_TONE: Record<RunStatus, StatusTone> = {
  queued: "live",
  running: "live",
  completed: "completed",
  completed_with_findings: "findings",
  review_invalid: "invalid",
  failed: "failed",
  cancelled: "cancelled",
  budget_exceeded: "failed",
  limit_exceeded: "failed",
  timed_out: "failed",
};

const TERMINAL: Record<RunStatus, boolean> = {
  queued: false,
  running: false,
  completed: true,
  completed_with_findings: true,
  review_invalid: true,
  failed: true,
  cancelled: true,
  budget_exceeded: true,
  limit_exceeded: true,
  timed_out: true,
};

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL[status];
}
