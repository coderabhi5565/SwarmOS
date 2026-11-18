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
        non_warmup_trials: 1,
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
    expect(within(parallel).getByText("measured n = 2").parentElement).toHaveTextContent(
      "measured n = 2 · 0 warm-ups · 1 excluded · 0 incomplete · 3 trials with results",
    );

    const sequential = within(byArm).getByRole("listitem", { name: "Results for sequential" });
    expect(within(sequential).getByText("task success (run completed)").nextSibling).toHaveTextContent("no counted trials");
    expect(within(sequential).getByText("run latency").nextSibling).toHaveTextContent("none recorded");
    expect(within(sequential).getByText("mean agent calls").nextSibling).toHaveTextContent("not established");
    // An unknown rate is never shown as 0%; a measured zero (no cancellation) is.
    expect(within(sequential).getByText("task success (run completed)").nextSibling).not.toHaveTextContent("0%");
    expect(within(sequential).getByText("verification passed").nextSibling).not.toHaveTextContent("0%");
    expect(within(sequential).getByText("cancelled").nextSibling).toHaveTextContent("0% (0 of 1 non-warm-up trials)");
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
    // The page reads its experiment; the header reads who is signed in. Nothing else.
    expect(paths.filter(([path]) => path.startsWith("/api/") && path !== "/api/auth/me")).toEqual([[PATH, "GET"]]);
    expect(paths.filter(([path]) => path === "/api/auth/me").every(([, method]) => method === "GET")).toBe(true);
  });
});

describe("aggregate metrics v2", () => {
  /** Arm parallel over two tasks: complete on one task (20 measured), short on the other (19). */
  function v2() {
    const lifecycle = { n: 3, missing: 1, missing_reasons: { "spans dropped": 1 }, median: 200, p95: 300, min: 100, max: 300 };
    return finished("completed", {
      aggregates: [
        aggregate({
          arm_id: "parallel",
          trials: 42,
          counted: 39,
          warmups: 2,
          excluded: 1,
          excluded_reasons: { cancelled: 1 },
          non_warmup_trials: 40,
          cancelled: 1,
          cancellation_rate: 0.025,
          interrupted: 0,
          interrupted_rate: 0,
          sample_complete: false,
          timings: { measured: 4, unavailable: { measurement_flush_failed: 1, metrics_v1: 34 }, metrics: { lifecycle_ms: lifecycle } },
        }),
        aggregate({
          arm_id: "sequential",
          trials: 1,
          counted: 0,
          warmups: 1,
          non_warmup_trials: 0,
          cancelled: 0,
          cancellation_rate: null,
          interrupted: 0,
          interrupted_rate: null,
          task_success_rate: null,
          verification_pass_rate: null,
          timings: { measured: 0, unavailable: {}, metrics: {} },
        }),
      ],
      task_aggregates: [
        aggregate({ arm_id: "parallel", task_id: "sample_tag_normalization", counted: 20, warmups: 1, sample_complete: true }),
        aggregate({ arm_id: "parallel", task_id: "sample_parallel_pipeline", counted: 19, warmups: 1, sample_complete: false }),
      ],
    });
  }

  const card = (region: string, name: string) => within(section(region)).getByRole("listitem", { name: `Results for ${name}` });

  it("marks complete and incomplete samples at the arm and task levels", async () => {
    serve(() => json(v2()));
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    expect(card("Results by arm and task", "parallel on sample_tag_normalization")).toHaveTextContent(
      "complete sample · 20 measured",
    );
    expect(card("Results by arm and task", "parallel on sample_parallel_pipeline")).toHaveTextContent(
      "incomplete sample · 19 of 20 measured",
    );
    // Over all tasks, complete only when every task is.
    expect(card("Results by arm", "parallel")).toHaveTextContent("incomplete sample · 20 measured per task needed");
  });

  it("separates measured n, warm-ups and exclusions, and gives each rate its denominator", async () => {
    serve(() => json(v2()));
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    const parallel = card("Results by arm", "parallel");
    expect(within(parallel).getByText("measured n = 39").parentElement).toHaveTextContent(
      "measured n = 39 · 2 warm-ups · 1 excluded · 0 incomplete · 42 trials with results",
    );
    expect(within(parallel).getByText("Excluded: cancelled (1)")).toBeInTheDocument();
    expect(within(parallel).getByText("cancelled").nextSibling).toHaveTextContent("2.5% (1 of 40 non-warm-up trials)");
    expect(within(parallel).getByText("interrupted").nextSibling).toHaveTextContent("0% (0 of 40 non-warm-up trials)");
  });

  it("shows an unknown rate, not 0%, when there is no non-warm-up trial", async () => {
    serve(() => json(v2()));
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    const sequential = card("Results by arm", "sequential");
    expect(within(sequential).getByText("cancelled").nextSibling).toHaveTextContent("no non-warm-up trials");
    expect(within(sequential).getByText("interrupted").nextSibling).not.toHaveTextContent("0%");
  });

  it("opens the timing distributions, with missing and unavailable trials counted", async () => {
    serve(() => json(v2()));
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    const parallel = card("Results by arm", "parallel");
    const summary = within(parallel).getByText("Run timings");
    expect(summary.closest("summary")).toHaveTextContent("Run timings · 4 of 39 counted measured");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    // A native disclosure: its summary takes keyboard focus (the browser toggles it with Enter or Space).
    const toggle = summary.closest("summary") as HTMLElement;
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    await userEvent.click(toggle);
    expect(details.open).toBe(true);
    expect(within(details).getByText(/have recorded run measurements/)).toHaveTextContent(
      "4 of 39 counted trials have recorded run measurements. The other 35 are left out of every timing figure: " +
        "measurements could not be saved (1); recorded before trial timings (34).",
    );
    const lifecycle = within(details).getByRole("rowheader", { name: /^lifecycle/ }).closest("tr") as HTMLElement;
    expect(within(lifecycle).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "3",
      "1",
      "200 ms",
      "300 ms",
      "100 ms",
      "300 ms",
    ]);
    expect(lifecycle).toHaveTextContent("missing: spans dropped (1)");
    // A metric the backend did not report is unknown, not zero.
    const planner = within(details).getByRole("rowheader", { name: /^planner/ }).closest("tr") as HTMLElement;
    expect(planner).toHaveTextContent("not reported");
  });

  it("explains an arm without measured trials and an experiment from before timings", async () => {
    serve(() => json(v2()));
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    const sequential = card("Results by arm", "sequential");
    await userEvent.click(within(sequential).getByText("Run timings"));
    expect(within(sequential).getByText("No timing figures: no counted trial has recorded run measurements.")).toBeInTheDocument();
  });

  it("states that twenty trials do not establish statistical significance", async () => {
    serve(() => json(v2()));
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    expect(section("Results by arm")).toHaveTextContent(
      "twenty trials per arm and task do not establish a statistically significant difference",
    );
    expect(section("Results by arm and task")).toHaveTextContent("The sample requirement applies here, to each arm and task.");
  });
});

describe("per-trial timings", () => {
  const recordedTimings = {
    measurement_status: "recorded" as const,
    measurements_version: 1,
    lifecycle_ms: 1420,
    admission_ms: 0.42,
    execution_ms: 1380,
    setup_ms: 12.5,
    graph_ms: 1300,
    finalization_ms: 30,
    planner_ms: null,
    reviewer_ms: 50,
    coder_busy_ms: 1100, // two overlapping steps: busy exceeds wall
    coder_wall_ms: 710,
    coder_critical_path_ms: 730,
    provider_calls: 3,
    provider_call_busy_ms: 1140,
    provider_call_wall_ms: 650,
    http_attempts: 0, // scripted provider: a measured zero
    http_attempt_busy_ms: 0,
    http_attempt_wall_ms: 0,
    parse_total_ms: 3,
    backoff_total_ms: 0,
    verification_ms: 370,
    diagnostic_verification_ms: null,
    graph_gap_ms: 180,
    critical_orchestration_ms: 350,
    parallel_orchestration_ms: 50,
    schedule_delay_total_ms: 50,
    slot_wait_total_ms: null,
    ledger_wait_total_ms: 2,
    trial_slot_wait_ms: 0.31,
    null_reasons: {
      planner_ms: "no planner node ran",
      diagnostic_verification_ms: "no diagnostic verification ran",
      slot_wait_total_ms: "parallel coding: no coding slot",
    },
  };
  const unavailable = {
    ...Object.fromEntries(Object.keys(recordedTimings).map((key) => [key, null])),
    measurement_status: "measurement_flush_failed" as const,
    measurements_version: null,
    null_reasons: { "*": "no run measurements: measurement_flush_failed" },
  } as unknown as typeof recordedTimings;

  function withTimings(experiment: Partial<BenchmarkExperimentDetail["experiment"]> = {}) {
    const warm = trialMetrics({ outcome: "excluded", excluded_reason: "warm-up", task_success: null, verification_passed: null, null_reasons: { "*": "excluded from the comparison: warm-up" } });
    return finished("completed", {
      experiment: { ...finished().experiment, warmup_repetitions: 1, repetitions: 4, ...experiment },
      trials: [
        trial({ trial_id: "w", ordinal: 0, repetition: 0, status: "done", run_id: "run_warm", metrics: warm }),
        trial({ trial_id: "a", ordinal: 1, repetition: 1, status: "done", run_id: "run_timed", metrics: trialMetrics({ metrics_version: 2, timings: recordedTimings }) }),
        trial({ trial_id: "b", ordinal: 2, repetition: 2, status: "done", run_id: "run_flush", metrics: trialMetrics({ metrics_version: 2, timings: unavailable }) }),
        trial({ trial_id: "c", ordinal: 3, repetition: 3, status: "done", run_id: "run_v1", metrics: trialMetrics({ metrics_version: 1, timings: null }) }),
        trial({
          trial_id: "d",
          ordinal: 4,
          repetition: 4,
          status: "done",
          run_id: "run_cancel",
          metrics: trialMetrics({ outcome: "excluded", excluded_reason: "cancelled", null_reasons: { "*": "excluded from the comparison: cancelled" } }),
        }),
        trial({ trial_id: "e", ordinal: 5, repetition: 4, arm_id: "sequential", status: "pending" }),
      ],
    });
  }

  const timingCell = (n: number) => within(trialRow(n)).getAllByRole("cell")[7];

  it("labels the warm-up and numbers measured repetitions from 1", async () => {
    serve(() => json(withTimings()));
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    expect(within(trialRow(1)).getAllByRole("cell")[1]).toHaveTextContent("parallel · sample_tag_normalization · warm-up");
    expect(within(trialRow(2)).getAllByRole("cell")[1]).toHaveTextContent("parallel · sample_tag_normalization · 1");
    expect(section("Trials")).toHaveTextContent("The first repetition of each arm and task is a warm-up, excluded from every result.");
  });

  it("gives each trial its lifecycle, or why it has no timings", async () => {
    serve(() => json(withTimings()));
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    expect(timingCell(1)).toHaveTextContent("warm-up: not measured");
    expect(timingCell(2)).toHaveTextContent("lifecycle 1.42 s");
    expect(timingCell(3)).toHaveTextContent("no run measurements: measurements could not be saved");
    expect(timingCell(4)).toHaveTextContent("recorded before trial timings");
    expect(timingCell(5)).toHaveTextContent("excluded (cancelled): not measured");
    expect(timingCell(6)).toHaveTextContent("no result");
    for (const n of [1, 3, 4, 5, 6]) expect(timingCell(n)).not.toHaveTextContent(/\b0 ms|0\.00 ms/);
  });

  it("lists every metric of a measured trial, with reasons for the missing ones", async () => {
    serve(() => json(withTimings()));
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    const timings = section("Trial timings");
    expect(timings).toHaveTextContent(
      "Without timings: warm-up: not measured (1); no run measurements: measurements could not be saved (1); " +
        "recorded before trial timings (1); excluded (cancelled): not measured (1).",
    );
    const entries = within(timings).getAllByRole("listitem");
    expect(entries).toHaveLength(1); // only the trial with recorded timings
    await userEvent.click(within(entries[0]).getByText(/#2 parallel · sample_tag_normalization · 1/));
    const value = (group: string, label: RegExp) =>
      within(within(entries[0]).getByRole("region", { name: group })).getByText(label).closest("div")?.querySelector("dd");
    expect(value("Agents", /^coder busy/)).toHaveTextContent("1.10 s");
    expect(value("Agents", /^coder wall/)).toHaveTextContent("710 ms");
    expect(value("Agents", /^coder critical path/)).toHaveTextContent("730 ms");
    expect(value("Agents", /^planner/)).toHaveTextContent("no planner node ran");
    expect(value("Run phases", /^admission/)).toHaveTextContent("0.42 ms");
    expect(value("Provider calls", /^HTTP attempts/)).toHaveTextContent(/^0$/); // a measured zero
    expect(value("Provider calls", /^call wall/)).toHaveTextContent("650 ms");
    expect(value("Waits", /^coding slot wait/)).toHaveTextContent("parallel coding: no coding slot");
    expect(value("Waits", /^trial slot wait/)).toHaveTextContent("0.31 ms");
    expect(value("Verification and orchestration", /^diagnostic verification/)).toHaveTextContent("no diagnostic verification ran");
    expect(within(entries[0]).getByText(/^coder busy/)).toHaveTextContent("busy: a sum, overlaps counted");
  });

  it("keeps a historical experiment's numbering and says it predates trial timings", async () => {
    serve(() => json(finished()));
    renderAt(`/benchmarks/${ID}`);
    await screen.findByRole("heading", { name: "Demo catalog" });
    expect(within(trialRow(1)).getAllByRole("cell")[1]).toHaveTextContent("parallel · sample_tag_normalization · 1");
    expect(timingCell(1)).toHaveTextContent("recorded before trial timings");
    expect(section("Trials")).not.toHaveTextContent("warm-up");
    expect(within(section("Trial timings")).getByText("No trial has recorded run timings.")).toBeInTheDocument();
  });
});
