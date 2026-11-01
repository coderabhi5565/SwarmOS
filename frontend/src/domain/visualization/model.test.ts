import { describe, expect, it } from "vitest";
import { createReplay, replay, type ExecutionState } from "@/domain/execution";
import { allFixtures, fixtures } from "@/domain/execution/fixtures";
import {
  buildVizModel,
  invocationsForNode,
  PLANNER_ID,
  reconcileVizModel,
  REVIEWER_ID,
  RUNNER_ID,
  stepNodeId,
  type VizModel,
} from "./model";

type Name = keyof typeof fixtures;

const final = (name: Name) => replay(fixtures[name].events, { seed: fixtures[name].run, settle: true });
const model = (name: Name) => buildVizModel(final(name));
const node = (viz: VizModel, id: string) => viz.nodes.find((candidate) => candidate.id === id)!;
const edgeIds = (viz: VizModel, kind: string) => viz.edges.filter((edge) => edge.kind === kind).map((edge) => edge.id);

/** Every frame of a fixture's replay, as visualisation models. */
function frames(name: Name): VizModel[] {
  const run = createReplay(fixtures[name].events, fixtures[name].run);
  return Array.from({ length: run.length }, (_, index) => buildVizModel(run.stateAtIndex(index)));
}

describe("buildVizModel", () => {
  it("draws the four actors with one node per coder step", () => {
    const viz = model("demoPipelineCompleted");
    expect(viz.nodes.map((n) => n.id)).toEqual([
      PLANNER_ID,
      "step:inspect_tests",
      "step:draft_implementation",
      "step:document_change",
      REVIEWER_ID,
      RUNNER_ID,
    ]);
    expect(viz.nodes.map((n) => n.kind)).toEqual(["agent", "step", "step", "step", "agent", "runner"]);
    expect(node(viz, RUNNER_ID)).toMatchObject({ role: "verifier", title: "Deterministic test runner" });
    expect(viz).toMatchObject({ status: "completed", finished: true, lifecycleRecorded: true });
  });

  it("marks a recipe plan: the planner never ran", () => {
    expect(node(model("demoPipelineCompleted"), PLANNER_ID)).toMatchObject({
      status: "skipped",
      attempts: 0,
      title: "Plan from the task recipe",
    });
    expect(node(model("parallelOverlap"), PLANNER_ID)).toMatchObject({ status: "succeeded", attempts: 1, title: null });
  });

  it("places waves in columns, in recorded order, between planner and reviewer", () => {
    const viz = model("parallelOverlap");
    expect(viz.waves).toEqual([
      { index: 0, stepIds: ["alpha", "beta"], parallel: true },
      { index: 1, stepIds: ["gamma"], parallel: false },
    ]);
    const place = (id: string) => [node(viz, id).column, node(viz, id).row];
    expect(place(PLANNER_ID)).toEqual([0, 0]);
    expect(place("step:alpha")).toEqual([1, -0.5]);
    expect(place("step:beta")).toEqual([1, 0.5]);
    expect(place("step:gamma")).toEqual([2, 0]);
    expect(place(REVIEWER_ID)).toEqual([3, 0]);
    expect(place(RUNNER_ID)).toEqual([4, 0]);
    expect(viz.columns).toBe(5);
  });

  it("draws dependency edges from recorded dependencies only", () => {
    const viz = model("parallelOverlap");
    expect(edgeIds(viz, "dependency")).toEqual([
      "dependency:step:alpha->step:gamma",
      "dependency:step:beta->step:gamma",
    ]);
    // Roots and sinks of the dependency graph join the pipeline.
    expect(edgeIds(viz, "flow")).toEqual([
      "flow:agent:planner->step:alpha",
      "flow:agent:planner->step:beta",
      "flow:step:gamma->agent:reviewer",
      "flow:agent:reviewer->runner:verifier",
    ]);
  });

  it("never infers dependencies the trace does not record", () => {
    const state = final("legacyLimitAtReview");
    const plan = state.plan!;
    const unknown: ExecutionState = {
      ...state,
      plan: {
        ...plan,
        dependenciesKnown: false,
        steps: Object.fromEntries(Object.entries(plan.steps).map(([id, step]) => [id, { ...step, dependsOn: null }])),
      },
    };
    const viz = buildVizModel(unknown);
    expect(viz.dependenciesKnown).toBe(false);
    expect(edgeIds(viz, "dependency")).toEqual([]);
    expect(node(viz, "step:update_tests").dependsOn).toBeNull();
    // Without dependencies the pipeline follows the recorded waves instead.
    expect(edgeIds(viz, "flow")).toEqual([
      "flow:agent:planner->step:normalize_tags",
      "flow:step:update_tests->agent:reviewer",
      "flow:agent:reviewer->runner:verifier",
    ]);
  });

  it("keeps a run with no plan drawable, without inventing steps", () => {
    const viz = model("timedOut");
    expect(viz.nodes.map((n) => n.id)).toEqual([PLANNER_ID, REVIEWER_ID, RUNNER_ID]);
    expect(viz.waves).toEqual([]);
    expect(edgeIds(viz, "flow")).toEqual(["flow:agent:planner->agent:reviewer", "flow:agent:reviewer->runner:verifier"]);
    expect(node(viz, PLANNER_ID).status).toBe("failed");
    // Never reached: idle, not failed and not skipped.
    expect(node(viz, REVIEWER_ID)).toMatchObject({ status: "idle", attempts: 0, startRecorded: false });
    expect(node(viz, RUNNER_ID)).toMatchObject({ status: "idle", attempts: 0 });
  });

  it("shows an interrupted call as interrupted, not failed or running", () => {
    const viz = model("cancelledMidCall");
    expect(viz.status).toBe("cancelled");
    expect(node(viz, PLANNER_ID)).toMatchObject({ status: "interrupted", active: false });
  });

  it("links revision requests from the reviewer to the step, with a count", () => {
    const viz = model("legacyPlannerRevision");
    const revision = viz.edges.find((edge) => edge.kind === "revision")!;
    expect(revision).toMatchObject({ source: REVIEWER_ID, target: "step:normalize_tags", count: 2 });
    expect(node(viz, "step:normalize_tags")).toMatchObject({ revisions: 2, attempts: 2 });
  });

  it("links repair rounds from the verifier to the step", () => {
    const viz = model("verificationRepair");
    expect(viz.edges.find((edge) => edge.kind === "repair")).toMatchObject({
      source: RUNNER_ID,
      target: "step:draft_implementation",
      count: 1,
    });
    expect(node(viz, "step:draft_implementation")).toMatchObject({ repairs: 1, attempts: 2 });
    expect(node(viz, RUNNER_ID).attempts).toBe(2);
  });

  it("marks retries and the escalated tier on the nodes that used it", () => {
    const viz = model("retryEscalation");
    expect(viz).toMatchObject({ tier: "strong", escalations: 1 });
    expect(node(viz, "step:alpha")).toMatchObject({ retried: true, attempts: 3, strongTier: true });
    expect(node(viz, PLANNER_ID).strongTier).toBe(false);
    // A retry re-dispatches the step: no extra edge, a badge on the node.
    expect(viz.edges.filter((edge) => edge.target === "step:alpha").map((edge) => edge.kind)).toEqual(["flow"]);
    expect(model("demoPipelineCompleted").escalations).toBe(0);
  });

  it("lists a node's own calls for the details panel", () => {
    const state = final("retryEscalation");
    const viz = buildVizModel(state);
    expect(invocationsForNode(state, node(viz, "step:alpha")).map((call) => call.stepId)).toEqual([
      "alpha",
      "alpha",
      "alpha",
    ]);
    expect(invocationsForNode(state, node(viz, PLANNER_ID)).map((call) => call.role)).toEqual(["planner"]);
    expect(invocationsForNode(state, node(viz, RUNNER_ID))).toEqual([]);
  });
});

describe("activity", () => {
  it("never shows a finished run as active", () => {
    for (const fixture of allFixtures) {
      const viz = buildVizModel(replay(fixture.events, { seed: fixture.run, settle: true }));
      expect(viz.finished, fixture.name).toBe(true);
      expect(viz.nodes.filter((n) => n.active), fixture.name).toEqual([]);
      expect(viz.edges.filter((e) => e.active), fixture.name).toEqual([]);
    }
  });

  it("never invents activity for traces without lifecycle events", () => {
    for (const name of ["legacyPlannerRevision", "legacyLimitAtReview", "legacyFalseBlocker"] as const) {
      for (const viz of frames(name)) {
        expect(viz.lifecycleRecorded).toBe(false);
        expect(viz.nodes.some((n) => n.active || n.startRecorded), name).toBe(false);
      }
    }
  });

  it("shows only what is running, between its start and its result", () => {
    const active = frames("demoPipelineCompleted").map((viz) => viz.nodes.filter((n) => n.active).map((n) => n.id));
    // Frame 3 is the first agent_started, frame 4 its result.
    expect(active.slice(0, 3)).toEqual([[], [], []]);
    expect(active[3]).toEqual(["step:inspect_tests"]);
    expect(active[4]).toEqual([]);
    expect(active.flat()).not.toContain(PLANNER_ID); // the recipe planner never ran
  });

  it("shows recorded overlap as concurrency, and nothing more", () => {
    const active = frames("parallelOverlap").map((viz) => viz.nodes.filter((n) => n.active).map((n) => n.id));
    expect(active).toContainEqual(["step:alpha", "step:beta"]);
    expect(Math.max(...active.map((ids) => ids.length))).toBe(2);
  });

  it("lights the edge that explains why a step is running", () => {
    const activeEdges = frames("reviewRevisionCompleted").map((viz) =>
      viz.edges.filter((e) => e.active).map((e) => e.id),
    );
    expect(activeEdges).toContainEqual(["flow:agent:planner->step:draft_implementation"]);
    expect(activeEdges).toContainEqual(["revision:agent:reviewer->step:draft_implementation"]);
    const repair = frames("verificationRepair").map((viz) => viz.edges.filter((e) => e.active).map((e) => e.id));
    expect(repair).toContainEqual(["repair:runner:verifier->step:draft_implementation"]);
  });
});

describe("live updates", () => {
  it("keeps node ids and positions fixed once the plan is known", () => {
    for (const name of Object.keys(fixtures) as Name[]) {
      const placed = new Map<string, string>();
      for (const viz of frames(name).filter((frame) => frame.waves.length > 0)) {
        for (const n of viz.nodes) {
          const place = `${n.column},${n.row}`;
          if (!placed.has(n.id)) placed.set(n.id, place);
          expect(place, `${name} ${n.id}`).toBe(placed.get(n.id));
        }
      }
    }
  });

  it("reuses unchanged nodes and edges, and the whole model when nothing changed", () => {
    const run = createReplay(fixtures.demoPipelineCompleted.events, fixtures.demoPipelineCompleted.run);
    let previous: VizModel | null = null;
    const models: VizModel[] = [];
    for (let index = 0; index < run.length; index++) {
      previous = reconcileVizModel(previous, buildVizModel(run.stateAtIndex(index)));
      models.push(previous);
    }
    // A poll that brings nothing new keeps the very same model.
    expect(reconcileVizModel(models[5], buildVizModel(run.stateAtIndex(5)))).toBe(models[5]);
    // Frame 3 starts one step: only that node and the edge into it change.
    const changed = models[3].nodes.filter((n, i) => n !== models[2].nodes[i]).map((n) => n.id);
    expect(changed).toEqual(["step:inspect_tests"]);
    const changedEdges = models[3].edges.filter((e, i) => e !== models[2].edges[i]).map((e) => e.id);
    expect(changedEdges).toEqual(["flow:agent:planner->step:inspect_tests"]);
  });

  it("matches a full rebuild after every frame", () => {
    const run = createReplay(fixtures.retryEscalation.events, fixtures.retryEscalation.run);
    let previous: VizModel | null = null;
    for (let index = 0; index < run.length; index++) {
      const fresh = buildVizModel(run.stateAtIndex(index));
      previous = reconcileVizModel(previous, fresh);
      expect(previous).toEqual(fresh);
    }
  });

  it("follows the reducer as live pages arrive", () => {
    const events = fixtures.parallelOverlap.events;
    const live = buildVizModel(replay(events.slice(0, 8), { seed: fixtures.parallelOverlap.run }));
    expect(live.finished).toBe(false);
    expect(live.nodes.filter((n) => n.active).map((n) => n.id)).toEqual(["step:alpha", "step:beta"]);
    const done = buildVizModel(replay(events, { seed: fixtures.parallelOverlap.run }));
    expect(done.nodes.filter((n) => n.active)).toEqual([]);
    expect(done.nodes.map((n) => n.id)).toEqual(live.nodes.map((n) => n.id));
  });

  it("is a pure function of the state", () => {
    const state = final("verificationRepair");
    expect(buildVizModel(state)).toEqual(buildVizModel(state));
    expect(stepNodeId("a b")).toBe("step:a b");
  });
});
