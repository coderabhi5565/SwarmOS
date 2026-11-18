/**
 * The landing page's trace walkthrough: events copied from a recorded run of
 * the public catalog task "Parallel pipeline" (the demo_pipeline_completed
 * fixture). Kinds, messages, seqs and payload fields are the backend's own;
 * each payload here is a subset of the recorded one. A test compares every
 * excerpt with the fixture, so this cannot drift into invention.
 */
export interface TraceExcerpt {
  seq: number;
  kind: string;
  message: string;
  payload: Record<string, unknown>;
}

export interface WalkthroughStep {
  id: string;
  tab: string;
  title: string;
  explanation: string;
  events: TraceExcerpt[];
}

export const WALKTHROUGH: WalkthroughStep[] = [
  {
    id: "plan",
    tab: "Plan",
    title: "A plan with dependency waves",
    explanation:
      "The run starts from a typed plan: steps, and the waves their dependencies allow. In the public demo the plan " +
      "comes from the curated task's recipe, so no planner model is called; with a real model the planner writes it " +
      "and the trace records plan_accepted instead.",
    events: [
      {
        seq: 2,
        kind: "routing_decision",
        message: "Plan supplied by the demo task recipe; planner model skipped",
        payload: {
          decision: "plan_seeded",
          steps: ["inspect_tests", "draft_implementation", "document_change"],
          waves: [["inspect_tests", "draft_implementation"], ["document_change"]],
        },
      },
    ],
  },
  {
    id: "wave",
    tab: "Parallel wave",
    title: "Independent steps run together, then merge",
    explanation:
      "Steps with no unresolved dependency are dispatched as one wave. Each coder works in its own checkout; the " +
      "scheduler merges a wave only after conflict checks, and records what it accepted.",
    events: [
      {
        seq: 3,
        kind: "routing_decision",
        message: "Dispatching 2 coding step(s)",
        payload: { decision: "dispatch_coding", steps: ["inspect_tests", "draft_implementation"], parallel: true },
      },
      {
        seq: 5,
        kind: "agent_invocation",
        message: "coder succeeded for inspect_tests",
        payload: { role: "coder", step_id: "inspect_tests", status: "succeeded", attempt: 1 },
      },
      {
        seq: 8,
        kind: "routing_decision",
        message: "Merged 1 file change(s) into the workspace",
        payload: { decision: "merge_wave", applied: 1, conflicts: [], files: ["target.py"] },
      },
    ],
  },
  {
    id: "review",
    tab: "Review",
    title: "A reviewer that must show evidence",
    explanation:
      "The reviewer's call is recorded like any other. Had it raised a blocker, the evidence guard would check that " +
      "the cited file, line and test output exist; a blocker without evidence ends the run as review_invalid, never " +
      "as an approval.",
    events: [
      {
        seq: 14,
        kind: "agent_invocation",
        message: "reviewer succeeded",
        payload: { role: "reviewer", status: "succeeded", attempt: 1 },
      },
    ],
  },
  {
    id: "verify",
    tab: "Verify",
    title: "Tests decide, not a model",
    explanation:
      "Verification runs the project's test command in a subprocess and records the exit code and counts. Task " +
      "success and a passed verification are separate facts in every report.",
    events: [
      {
        seq: 16,
        kind: "verification",
        message: "Verification passed",
        payload: { passed: true, exit_code: 0, tests_passed: 3, tests_failed: 0, diagnostic: false },
      },
    ],
  },
];
