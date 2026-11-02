import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BENCHMARK_POLL_MS } from "@/api/benchmarkQueries";
import type { BenchmarkExperimentDetail, BenchmarkExperimentStatus, Health } from "@/api/types";
import { json, requestsTo, stubFetch } from "@/test/api";
import { aggregate, experimentDetail, trial, trialMetrics } from "@/test/benchmarks";
import { renderAt } from "@/test/render";

const ID = "bex_detail000001";
const PATH = `/api/benchmarks/experiments/${ID}`;

const health: Health = {
  status: "ok",
  service: "swarmos",
  version: "0.3.0",
  mode: "local",
  provider_mode: "auto",
  provider_kind: "demo",
  openai_configured: false,
  auth_required: false,
};

const SCRIPTED_NOTE = "Scripted provider: the agents follow a script, so these results describe the orchestration, not a model's ability.";

/** A finished experiment with every kind of trial the backend reports. */
function finished(status: BenchmarkExperimentStatus = "completed", overrides: Partial<BenchmarkExperimentDetail> = {}) {
  const base = experimentDetail(
    {
      experiment_id: ID,
      status,
      suite_title: "Demo catalog",
      suite_version: "v1-0123456789ab",
      arm_ids: ["parallel", "sequential"],
      repetitions: 3,
      trials_total: 6,
      trials_done: 4,
      started_at: "2026-11-02T10:00:01+00:00",
      finished_at: "2026-11-02T10:01:31+00:00",
      origin: "cli",
    },
    {
      order_seed: 12345,
      notes: [SCRIPTED_NOTE, "No arm is declared best: compare the numbers with their sample sizes."],
    },
  );
  return {
    ...base,
    configurations: [
      { ...base.configurations[0], arm_id: "parallel", fingerprint: "aaaa1111bbbb2222" },
      { ...base.configurations[0], arm_id: "sequential", parallel_relevant: null, escalation_possible: true, escalation_unavailable: [], fingerprint: "cccc3333dddd4444" },
    ],
    identical_by_design: [
      {
        task_id: "sample_tag_normalization",
        arm_ids: ["parallel", "sequential"],
        fingerprint: "aaaa1111bbbb2222",
        reasons: ["the task has no wave with more than one step, so parallel and sequential coding schedule it identically"],
        explanation: "On sample_tag_normalization, the arms parallel, sequential run identically by construction.",
      },
    ],
    aggregates: [
      aggregate({
        arm_id: "parallel",
        trials: 3,
        counted: 2,
        excluded: 1,
        excluded_reasons: { cancelled: 1 },
        trial_statuses: { done: 3 },
        task_successes: 1,
        task_success_rate: 0.5,
        verification_passes: 2,
        verification_pass_rate: 1,
        notes: ["P95 latency is from 2 runs (fewer than 20); it is one of the slowest runs observed, not a stable tail estimate."],
      }),
      aggregate({
        arm_id: "sequential",
        trials: 1,
        counted: 0,
        trial_statuses: { done: 1, error: 1, not_run: 1 },
        task_successes: 0,
        task_success_rate: null,
        verification_passes: 0,
        verification_pass_rate: null,
        latency_ms: { n: 0, median: null, p95: null, mean: null, min: null, max: null },
        mean_agent_calls: null,
      }),
    ],
    task_aggregates: [aggregate({ arm_id: "parallel", task_id: "sample_tag_normalization", task_successes: 1, task_success_rate: 0.5, counted: 2 })],
    trials: [
      trial({ trial_id: "t1", ordinal: 0, status: "done", run_id: "run_success0001", metrics: trialMetrics({ run_id: "run_success0001" }) }),
      trial({
        trial_id: "t2",
        ordinal: 1,
        status: "done",
        run_id: "run_findings001",
        metrics: trialMetrics({ run_id: "run_findings001", status: "completed_with_findings", outcome: "failure", task_success: false, verification_passed: true, step_retries: 2, call_retries: 0 }),
      }),
      trial({
        trial_id: "t3",
        ordinal: 2,
        status: "done",
        run_id: "run_cancelled01",
        metrics: trialMetrics({
          run_id: "run_cancelled01",
          status: "cancelled",
          outcome: "excluded",
          excluded_reason: "cancelled",
          task_success: null,
          verification_passed: null,
          latency_ms: null,
          agent_calls: null,
          null_reasons: { "*": "excluded from the comparison: cancelled" },
        }),
      }),
      trial({ trial_id: "t4", ordinal: 3, arm_id: "sequential", status: "error", error: "the run could not be started: endpoint removed" }),
      trial({ trial_id: "t5", ordinal: 4, arm_id: "sequential", status: "not_run", error: "cancelled on request" }),
      trial({
        trial_id: "t6",
        ordinal: 5,
        arm_id: "sequential",
        status: "done",
        run_id: "run_noverify001",
        metrics: trialMetrics({ run_id: "run_noverify001", status: "review_invalid", outcome: "failure", task_success: false, verification_passed: false, verification_runs: 0, diagnostic_tests_passed: true }),
      }),
    ],
    ...overrides,
  } satisfies BenchmarkExperimentDetail;
}

function serve(answer: () => Response) {
  return stubFetch((url) => {
    if (url.pathname === "/health") return json(health);
    if (url.pathname === PATH) return answer();
    return undefined;
  });
}

const section = (name: string) => screen.getByRole("region", { name });
const trialRow = (n: number) => within(screen.getByRole("table", { name: "Trials" })).getByRole("row", { name: new RegExp(`^Trial ${n}:`) });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("benchmark experiment page", () => {
  it("loads lazily, shows a skeleton, then the experiment with the backend's notes", async () => {
    serve(() => json(finished()));
    renderAt(`/benchmarks/${ID}`);
    expect(await screen.findByLabelText("Loading experiment")).toHaveAttribute("aria-busy", "true");
    const heading = await screen.findByRole("heading", { name: "Demo catalog" });
    const header = heading.closest("header")!;
    expect(within(header).getByText("completed")).toBeInTheDocument();
    expect(within(header).getByText("scripted provider")).toBeInTheDocument();
    expect(within(header).getByText(ID)).toBeInTheDocument();
    const notes = screen.getByRole("note", { name: "About these results" });
    expect(notes).toHaveTextContent("describe the orchestration, not a model's ability");
    expect(notes).toHaveTextContent("No arm is declared best");
  });

  it("shows the overview and provenance the backend recorded", async () => {
    serve(() => json(finished()));
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    const overview = section("Overview");
    const fact = (label: string) => within(overview).getByText(label, { selector: "dt" }).nextElementSibling;
    expect(fact("suite")).toHaveTextContent("catalog v1-0123456789ab");
    expect(fact("arms")).toHaveTextContent("parallel, sequential");
    expect(fact("repetitions")).toHaveTextContent(/^3$/);
    expect(fact("trials done")).toHaveTextContent("4 of 6");
    expect(fact("started")).not.toHaveTextContent("not");
    expect(fact("finished")).not.toHaveTextContent(/unknown|in progress/);
    expect(fact("took")).toHaveTextContent(/^1\D+30 s$/);
    expect(fact("started by")).toHaveTextContent("CLI");
    expect(fact("trial order seed")).toHaveTextContent("12345");
    const provenance = section("Provenance");
    expect(within(provenance).getByText("scripted provider")).toBeInTheDocument();
    expect(within(provenance).getByText("python -m pytest -q")).toBeInTheDocument();
    expect(within(provenance).getByText("3.13.3")).toBeInTheDocument();
    expect(within(provenance).getByText("enabled · none sandbox")).toBeInTheDocument();
    // build_commit is null: unknown, not blank and not invented.
    expect(within(provenance).getByText("not recorded")).toBeInTheDocument();
  });

  it("says host details were not disclosed when the backend withholds them", async () => {
    const detail = finished();
    serve(() => json({ ...detail, environment: { ...detail.environment, python_version: null, platform: null } }));
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    expect(within(section("Provenance")).getAllByText("not disclosed")).toHaveLength(2);
  });

  it("lists each arm's recorded configuration, with escalation reasons and unknowns", async () => {
    serve(() => json(finished()));
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    const configurations = section("Arm configurations");
    const rows = within(configurations).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("not possible")).toBeInTheDocument();
    expect(within(rows[0]).getByText("the demo fixture has a single scripted model")).toBeInTheDocument();
    expect(within(rows[0]).getByText("coder: demo-fast")).toBeInTheDocument();
    expect(within(rows[0]).getByText("aaaa1111bbbb2222")).toBeInTheDocument();
    expect(within(rows[1]).getByText("possible")).toBeInTheDocument();
    expect(within(rows[1]).getByText("unknown")).toBeInTheDocument(); // parallel_relevant null
  });

  it("shows identical-by-design warnings only as the backend reports them", async () => {
    serve(() => json(finished()));
    const { unmount } = renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    const warnings = section("Identical by design");
    expect(within(warnings).getByText(/run identically by construction/)).toBeInTheDocument();
    expect(within(warnings).getByText(/schedule it identically/)).toBeInTheDocument();
    unmount();

    // Same arms and labels, but the backend reports no group: none is inferred.
    serve(() => json(finished("completed", { identical_by_design: [] })));
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    expect(within(section("Identical by design")).getByText("No arms ran identically by construction on any task.")).toBeInTheDocument();
  });

  it("keeps task success and verification apart, and unknowns unknown, in the aggregates", async () => {
    serve(() => json(finished()));
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    const byArm = section("Results by arm");
    const parallel = within(byArm).getByRole("listitem", { name: "Results for parallel" });
    expect(within(parallel).getByText("task success (run completed)").nextSibling).toHaveTextContent("50% (1 of 2)");
    expect(within(parallel).getByText("verification passed").nextSibling).toHaveTextContent("100% (2 of 2)");
    expect(within(parallel).getByText("run latency").nextSibling).toHaveTextContent("median 3.3 s · p95 3.4 s (n=2)");
    expect(within(parallel).getByText("model-call latency").nextSibling).toHaveTextContent("none recorded");
    expect(within(parallel).getByText(/mean tokens in \/ out/).nextSibling).toHaveTextContent("no run reported usage");
    expect(within(parallel).getByText(/^cost/).nextSibling).toHaveTextContent("not established");
    expect(within(parallel).getByText("Excluded: cancelled (1)")).toBeInTheDocument();
    expect(within(parallel).getByText(/P95 latency is from 2 runs/)).toBeInTheDocument();
    expect(within(parallel).getByText(/3 trials with results · 2 counted · 1 excluded/)).toBeInTheDocument();

    const sequential = within(byArm).getByRole("listitem", { name: "Results for sequential" });
    expect(within(sequential).getByText("task success (run completed)").nextSibling).toHaveTextContent("no counted trials");
    expect(within(sequential).getByText("run latency").nextSibling).toHaveTextContent("none recorded");
    expect(within(sequential).getByText("mean agent calls").nextSibling).toHaveTextContent("not established");
    expect(within(sequential).queryByText("0%")).not.toBeInTheDocument();
    expect(within(sequential).getByText(/1 done, 1 error, 1 not run/)).toBeInTheDocument();

    const byTask = section("Results by arm and task");
    expect(within(byTask).getByRole("listitem", { name: "Results for parallel on sample_tag_normalization" })).toBeInTheDocument();
  });

  it("lists every trial with its outcome, reasons and run", async () => {
    serve(() => json(finished()));
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });

    const success = trialRow(1);
    expect(within(success).getByText("task succeeded")).toBeInTheDocument();
    expect(within(success).getByText("3.4 s")).toBeInTheDocument();
    expect(within(success).getByRole("link", { name: "run_success0001" })).toHaveAttribute("href", "/runs/run_success0001");

    // Task failed but verification passed: two different facts.
    const findings = trialRow(2);
    expect(within(findings).getByText("task failed")).toBeInTheDocument();
    const [, , , taskSuccess, verification, , calls] = within(findings).getAllByRole("cell");
    expect(taskSuccess).toHaveTextContent("no");
    expect(verification).toHaveTextContent("passed");
    expect(calls).toHaveTextContent("2 · 2/0");

    // Excluded: the reason, and the backend's reason for every unknown.
    const excluded = trialRow(3);
    expect(within(excluded).getByText("excluded")).toBeInTheDocument();
    expect(within(excluded).getByText("cancelled")).toBeInTheDocument();
    expect(within(excluded).getAllByText("excluded from the comparison: cancelled").length).toBeGreaterThanOrEqual(3);
    expect(within(excluded).queryByText(/^0/)).not.toBeInTheDocument();

    const errored = trialRow(4);
    expect(within(errored).getByText("error")).toBeInTheDocument();
    expect(within(errored).getByText("the run could not be started: endpoint removed")).toBeInTheDocument();
    expect(within(errored).getByText("no run")).toBeInTheDocument();
    expect(within(errored).getAllByText("no result").length).toBeGreaterThan(0);

    const notRun = trialRow(5);
    expect(within(notRun).getByText("not run")).toBeInTheDocument();
    expect(within(notRun).getByText("cancelled on request")).toBeInTheDocument();

    const noVerification = trialRow(6);
    const cells = within(noVerification).getAllByRole("cell");
    expect(cells[4]).toHaveTextContent("did not run");
    expect(cells[4]).toHaveTextContent("diagnostic tests passed (not a verification)");
  });

  it("opens a trial's run", async () => {
    serve(() => json(finished()));
    const { router } = renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    await userEvent.click(within(trialRow(2)).getByRole("link", { name: "run_findings001" }));
    expect(router.state.location.pathname).toBe("/runs/run_findings001");
  });

  it("says when an experiment does not exist", async () => {
    serve(() => json({ detail: `experiment ${ID} not found` }, 404));
    renderAt(`/benchmarks/${ID}`);
    const heading = await screen.findByRole("heading", { name: "Experiment not found" });
    const page = heading.parentElement!;
    expect(within(page).getByText(ID)).toBeInTheDocument();
    expect(within(page).getByRole("link", { name: "Benchmarks" })).toHaveAttribute("href", "/benchmarks");
  });

  it("reports another failure and retries on request", async () => {
    let fail = true;
    serve(() => (fail ? json({ detail: "trace store unavailable" }, 400) : json(finished())));
    renderAt(`/benchmarks/${ID}`);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load this experiment: trace store unavailable");
    fail = false;
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Demo catalog" })).toBeInTheDocument();
  });

  it("follows a queued experiment while it runs, and stops when it ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sequence: BenchmarkExperimentStatus[] = ["queued", "running", "completed"];
    let served = 0;
    const mock = serve(() => {
      const status = sequence[Math.min(served, sequence.length - 1)];
      served += 1;
      const active = status !== "completed";
      return json(
        finished(status, {
          experiment: { ...finished().experiment, status, finished_at: active ? null : "2026-11-02T10:01:31+00:00", started_at: status === "queued" ? null : "2026-11-02T10:00:01+00:00" },
        }),
      );
    });
    renderAt(`/benchmarks/${ID}`);
    const heading = await screen.findByRole("heading", { name: "Demo catalog" });
    const header = heading.closest("header")!;
    expect(within(header).getByText("queued")).toBeInTheDocument();
    expect(within(header).getByText("refreshing every 2 s")).toBeInTheDocument();
    expect(within(section("Overview")).getByText("not yet")).toBeInTheDocument();
    expect(within(section("Overview")).getAllByText("in progress")).toHaveLength(2);

    await act(() => vi.advanceTimersByTimeAsync(BENCHMARK_POLL_MS));
    await waitFor(() => expect(within(header).getByText("running")).toBeInTheDocument());
    await act(() => vi.advanceTimersByTimeAsync(BENCHMARK_POLL_MS));
    await waitFor(() => expect(within(header).getByText("completed")).toBeInTheDocument());
    expect(within(header).queryByText("refreshing every 2 s")).not.toBeInTheDocument();
    const settled = requestsTo(mock, PATH).length;
    expect(settled).toBe(3);

    await act(() => vi.advanceTimersByTimeAsync(BENCHMARK_POLL_MS * 10));
    expect(requestsTo(mock, PATH)).toHaveLength(settled);
  });

  it.each<BenchmarkExperimentStatus>(["completed", "partial", "cancelled", "failed", "interrupted"])(
    "shows a %s experiment once, without polling",
    async (status) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const mock = serve(() => json(finished(status, { experiment: { ...finished().experiment, status, error: status === "completed" ? null : `ended: ${status}` } })));
      renderAt(`/benchmarks/${ID}`);
      const header = (await screen.findByRole("heading", { name: "Demo catalog" })).closest("header")!;
      expect(within(header).getByText(status)).toBeInTheDocument();
      expect(within(header).queryByText("refreshing every 2 s")).not.toBeInTheDocument();
      if (status !== "completed") expect(within(header).getByText(`ended: ${status}`)).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(BENCHMARK_POLL_MS * 5));
      expect(requestsTo(mock, PATH)).toHaveLength(1);
    },
  );

  it("keeps the last data when a refresh fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let served = 0;
    serve(() => {
      served += 1;
      return served === 1 ? json(finished("running", { experiment: { ...finished().experiment, status: "running", finished_at: null } })) : json({ detail: "temporarily unavailable" }, 400);
    });
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    await act(() => vi.advanceTimersByTimeAsync(BENCHMARK_POLL_MS));
    expect(await screen.findByText(/Could not refresh \(temporarily unavailable\)/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Demo catalog" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Trials" })).toBeInTheDocument();
  });

  it("draws no charts and makes no other requests", async () => {
    const mock = serve(() => json(finished()));
    const { container } = renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    expect(container.querySelector("canvas")).toBeNull();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect([...container.querySelectorAll("svg")].every((svg) => svg.getAttribute("aria-hidden") === "true")).toBe(true);
    const paths = mock.mock.calls.map(([input, init]) => [new URL(String(input), "http://localhost").pathname, init?.method ?? "GET"]);
    expect(paths.filter(([path]) => path.startsWith("/api/"))).toEqual([[PATH, "GET"]]);
  });
});
