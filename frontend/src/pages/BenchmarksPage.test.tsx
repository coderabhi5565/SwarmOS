import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BENCHMARK_POLL_MS } from "@/api/benchmarkQueries";
import type { BenchmarkExperimentList, BenchmarkExperimentSummary, Health } from "@/api/types";
import { json, requestsTo, stubFetch } from "@/test/api";
import { experimentPage, experimentSummary } from "@/test/benchmarks";
import { renderAt } from "@/test/render";

const EXPERIMENTS = "/api/benchmarks/experiments";

const health: Health = {
  status: "ok",
  service: "swarmos",
  version: "0.3.0",
  mode: "public_demo",
  provider_mode: "auto",
  provider_kind: "demo",
  openai_configured: false,
  auth_required: false,
};

/** Serve list pages by cursor ("" for the first page); `pages` may be swapped mid-test. */
function serve(pages: { current: Record<string, BenchmarkExperimentList | number> }) {
  return stubFetch((url) => {
    if (url.pathname === "/health") return json(health);
    if (url.pathname !== EXPERIMENTS) return undefined;
    const page = pages.current[url.searchParams.get("cursor") ?? ""];
    if (typeof page === "number") return json({ detail: "trace store unavailable" }, page);
    return json(page ?? experimentPage([]));
  });
}

const rows = () => within(screen.getByRole("list", { name: "Experiments" })).getAllByRole("link");
const experimentRequests = (mock: ReturnType<typeof stubFetch>) => requestsTo(mock, EXPERIMENTS);

const completed = (id: string, extra: Partial<BenchmarkExperimentSummary> = {}) =>
  experimentSummary({
    experiment_id: id,
    status: "completed",
    trials_done: 2,
    finished_at: "2026-11-02T10:00:31+00:00",
    ...extra,
  });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("benchmarks page", () => {
  it("is reached from the navigation and loads lazily", async () => {
    serve({ current: { "": experimentPage([completed("bex_a")]) } });
    const { router } = renderAt("/");
    await userEvent.click((await screen.findAllByRole("link", { name: "Benchmarks" }))[0]);
    expect(router.state.location.pathname).toBe("/benchmarks");
    expect(await screen.findByRole("heading", { name: "Experiments" })).toBeInTheDocument();
  });

  it("shows a skeleton while loading, then each experiment's facts", async () => {
    serve({
      current: {
        "": experimentPage([
          experimentSummary({ experiment_id: "bex_live", status: "running", trials_done: 1, trials_total: 4 }),
          completed("bex_done", {
            suite_title: "Local fixtures",
            suite_version: "v1-fedcba987654",
            provider: "openai-compatible:local",
            provider_kind: "local",
            scripted: false,
          }),
        ]),
      },
    });
    renderAt("/benchmarks");
    expect(await screen.findByLabelText("Loading experiments")).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(rows()).toHaveLength(2));

    const [live, done] = rows();
    expect(live).toHaveAttribute("href", "/benchmarks/bex_live");
    expect(within(live).getByText("running")).toBeInTheDocument();
    expect(within(live).getByText("1/4 done")).toBeInTheDocument();
    expect(within(live).getByText("v1-0123456789ab")).toBeInTheDocument();
    expect(within(live).getByText("2026-11-02 10:00 UTC")).toBeInTheDocument();
    expect(within(live).getAllByText("in progress")).toHaveLength(2); // finished, took
    expect(within(live).getByText("scripted provider")).toBeInTheDocument();
    expect(within(live).getByText("demo (demo)")).toBeInTheDocument();

    expect(done).toHaveAttribute("href", "/benchmarks/bex_done");
    expect(within(done).getByText("completed")).toBeInTheDocument();
    expect(within(done).getByText("Local fixtures")).toBeInTheDocument();
    expect(within(done).getByText("v1-fedcba987654")).toBeInTheDocument();
    expect(within(done).getByText("2/2 done")).toBeInTheDocument();
    expect(within(done).getByText("30 s")).toBeInTheDocument(); // started 10:00:01, finished 10:00:31
    expect(within(done).getByText("real model")).toBeInTheDocument();
    expect(within(done).getByText("openai-compatible:local (local)")).toBeInTheDocument();
  });

  it("explains scripted results, and only when there are some", async () => {
    serve({ current: { "": experimentPage([completed("bex_s")]) } });
    const { unmount } = renderAt("/benchmarks");
    expect(await screen.findByRole("note")).toHaveTextContent("describe the orchestration, not a model");
    unmount();

    serve({ current: { "": experimentPage([completed("bex_r", { scripted: false, provider_kind: "local" })]) } });
    renderAt("/benchmarks");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("shows what was not recorded as unknown, never as zero", async () => {
    serve({
      current: {
        "": experimentPage([
          experimentSummary({ experiment_id: "bex_x", status: "interrupted", started_at: null, finished_at: null, trials_done: 0 }),
        ]),
      },
    });
    renderAt("/benchmarks");
    await waitFor(() => expect(rows()).toHaveLength(1));
    const [row] = rows();
    expect(within(row).getAllByText("not recorded")).toHaveLength(2); // finished, took
    expect(within(row).queryByText("0 ms")).not.toBeInTheDocument();
    expect(within(row).getByText("0/2 done")).toBeInTheDocument(); // a real count
  });

  it("shows the experiment's own reason when it has one", async () => {
    serve({ current: { "": experimentPage([completed("bex_p", { status: "partial", error: "1 of 2 trials did not run" })]) } });
    renderAt("/benchmarks");
    expect(await screen.findByText("1 of 2 trials did not run")).toBeInTheDocument();
    expect(screen.getByText("partial")).toBeInTheDocument();
  });

  it("says when there are no experiments, and does not poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mock = serve({ current: { "": experimentPage([]) } });
    renderAt("/benchmarks");
    expect(await screen.findByText("No experiments yet")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(BENCHMARK_POLL_MS * 5));
    expect(experimentRequests(mock)).toHaveLength(1);
  });

  it("reports a failed load and retries on request", async () => {
    const pages = { current: { "": 400 } as Record<string, BenchmarkExperimentList | number> };
    serve(pages);
    renderAt("/benchmarks");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load experiments: trace store unavailable");
    pages.current = { "": experimentPage([completed("bex_back")]) };
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("loads older experiments with the server's cursor", async () => {
    const mock = serve({
      current: {
        "": experimentPage([completed("bex_3"), completed("bex_2")], "bex_2"),
        bex_2: experimentPage([completed("bex_1")], null),
      },
    });
    renderAt("/benchmarks");
    await waitFor(() => expect(rows()).toHaveLength(2));
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows().map((row) => row.getAttribute("href"))).toEqual([
      "/benchmarks/bex_3",
      "/benchmarks/bex_2",
      "/benchmarks/bex_1",
    ]);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(experimentRequests(mock).map((url) => url.searchParams.get("cursor"))).toEqual([null, "bex_2"]);
  });

  it("refreshes every 2 s while an experiment is active, and stops when all are terminal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pages = {
      current: { "": experimentPage([experimentSummary({ experiment_id: "bex_live", status: "running" }), completed("bex_old")]) } as Record<
        string,
        BenchmarkExperimentList | number
      >,
    };
    const mock = serve(pages);
    renderAt("/benchmarks");
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(experimentRequests(mock)).toHaveLength(1);

    await act(() => vi.advanceTimersByTimeAsync(BENCHMARK_POLL_MS));
    await waitFor(() => expect(experimentRequests(mock)).toHaveLength(2));

    pages.current = { "": experimentPage([completed("bex_live"), completed("bex_old")]) };
    await act(() => vi.advanceTimersByTimeAsync(BENCHMARK_POLL_MS));
    await waitFor(() => expect(within(rows()[0]).getByText("completed")).toBeInTheDocument());
    const settled = experimentRequests(mock).length;

    await act(() => vi.advanceTimersByTimeAsync(BENCHMARK_POLL_MS * 10));
    expect(experimentRequests(mock)).toHaveLength(settled);
  });

  it("keeps loaded pages through a refresh and shows each experiment once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pages = {
      current: {
        "": experimentPage([completed("bex_4"), completed("bex_3")], "bex_3"),
        bex_3: experimentPage([experimentSummary({ experiment_id: "bex_2", status: "running" }), completed("bex_1")], null),
      } as Record<string, BenchmarkExperimentList | number>,
    };
    const mock = serve(pages);
    renderAt("/benchmarks");
    await waitFor(() => expect(rows()).toHaveLength(2));
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(rows()).toHaveLength(4));

    // A new experiment arrives at the top; the server's pages shift, and the
    // second page now overlaps the first.
    pages.current = {
      "": experimentPage([completed("bex_5"), completed("bex_4"), completed("bex_3")], "bex_3"),
      bex_3: experimentPage([completed("bex_3"), completed("bex_2"), completed("bex_1")], null),
    };
    const before = experimentRequests(mock).length;
    await act(() => vi.advanceTimersByTimeAsync(BENCHMARK_POLL_MS));
    await waitFor(() => expect(rows()).toHaveLength(5));

    expect(rows().map((row) => row.getAttribute("href"))).toEqual(
      ["bex_5", "bex_4", "bex_3", "bex_2", "bex_1"].map((id) => `/benchmarks/${id}`),
    );
    // Both loaded pages were refreshed, the second from the fresh first page's cursor.
    expect(experimentRequests(mock).slice(before).map((url) => url.searchParams.get("cursor"))).toEqual([null, "bex_3"]);
  });

  it("only ever reads: no POST is sent", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mock = serve({ current: { "": experimentPage([experimentSummary({ status: "queued" })]) } });
    renderAt("/benchmarks");
    await waitFor(() => expect(rows()).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(BENCHMARK_POLL_MS * 2));
    const methods = mock.mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.length).toBeGreaterThan(1);
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  });
});
