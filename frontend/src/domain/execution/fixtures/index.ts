/**
 * Recorded traces (see scripts/record_trace_fixtures.py). Test-only: nothing
 * in the app imports this module, so the JSON never reaches the bundle.
 */
import type { TraceEvent } from "@/api/types";
import type { RunSeed } from "../model";
import callLimitExhausted from "./call_limit_exhausted.json";
import cancelledMidCall from "./cancelled_mid_call.json";
import demoPipelineCompleted from "./demo_pipeline_completed.json";
import legacyFalseBlocker from "./legacy_false_blocker.json";
import legacyLimitAtReview from "./legacy_limit_at_review.json";
import legacyPlannerRevision from "./legacy_planner_revision.json";
import parallelOverlap from "./parallel_overlap.json";
import retryEscalation from "./retry_escalation.json";
import reviewInvalid from "./review_invalid.json";
import reviewRevisionCompleted from "./review_revision_completed.json";
import timedOut from "./timed_out.json";
import verificationRepair from "./verification_repair.json";

export interface TraceFixture {
  name: string;
  description: string;
  source: string;
  run: RunSeed;
  events: TraceEvent[];
}

const fixture = (json: unknown) => json as TraceFixture;

export const fixtures = {
  demoPipelineCompleted: fixture(demoPipelineCompleted),
  parallelOverlap: fixture(parallelOverlap),
  reviewRevisionCompleted: fixture(reviewRevisionCompleted),
  reviewInvalid: fixture(reviewInvalid),
  verificationRepair: fixture(verificationRepair),
  retryEscalation: fixture(retryEscalation),
  callLimitExhausted: fixture(callLimitExhausted),
  timedOut: fixture(timedOut),
  cancelledMidCall: fixture(cancelledMidCall),
  legacyPlannerRevision: fixture(legacyPlannerRevision),
  legacyLimitAtReview: fixture(legacyLimitAtReview),
  legacyFalseBlocker: fixture(legacyFalseBlocker),
};

export const allFixtures: TraceFixture[] = Object.values(fixtures);
