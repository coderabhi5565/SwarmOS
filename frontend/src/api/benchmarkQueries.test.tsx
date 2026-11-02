import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/api/client";
import {
  BENCHMARK_POLL_MS,
  benchmarkKeys,
  experimentListPollInterval,
  experimentPollInterval,
  experimentsFromPages,
  isActiveExperiment,
  useBenchmarkExperiment,
  useBenchmarkExperiments,
  useBenchmarkSuites,
  useCancelBenchmarkExperiment,
  useCreateBenchmarkExperiment,
} from "@/api/benchmarkQueries";
import { createQueryClient } from "@/api/queryClient";
import type { BenchmarkExperimentStatus } from "@/api/types";
import { json, requestsTo, stubFetch } from "@/test/api";
import { benchmarkSuites, experimentDetail, experimentPage, experimentSummary } from "@/test/benchmarks";

const EXPERIMENTS = "/api/benchmarks/experiments";
const ID = "bex_000000000001";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function wrapper(client: QueryClient = createQueryClient()) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The method and JSON body of every request the stub saw for a path. */
function calls(mock: ReturnType<typeof stubFetch>, path: string) {
  return mock.mock.calls
    .filter(([input]) => new URL(String(input), "http://localhost").pathname === path)
    .map(([, init]) => ({ method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null }));
}

// ----------------------------------------------------------------------
// client functions
// ----------------------------------------------------------------------
describe("benchmark API functions", () => {
  it("call the five benchmark routes with the right methods, queries and bodies", async () => {
    const mock = stubFetch((url) => {
      if (url.pathname === "/api/benchmarks/suites") return json(benchmarkSuites());
      if (url.pathname === EXPERIMENTS) return json(experimentPage([experimentSummary()]), 200);
      if (url.pathname === `${EXPERIMENTS}/${ID}`) return json(experimentDetail());
      if (url.pathname === `${EXPERIMENTS}/${ID}/cancel`) return json({ experiment_id: ID, status: "cancelling" }, 202);
      return undefined;
    });

    expect((await api.benchmarkSuites()).can_create).toBe(true);
    await api.listBenchmarkExperiments({ limit: 5, cursor: "bex_cursor" });
    await api.listBenchmarkExperiments();
    expect((await api.getBenchmarkExperiment(ID)).experiment.experiment_id).toBe(ID);
    await api.createBenchmarkExperiment({ suite_id: "catalog", arm_ids: ["parallel"] });
    expect(await api.cancelBenchmarkExperiment(ID)).toEqual({ experiment_id: ID, status: "cancelling" });

    const lists = requestsTo(mock, EXPERIMENTS).filter((_, index) => calls(mock, EXPERIMENTS)[index].method === "GET");
    expect(lists[0].searchParams.get("limit")).toBe("5");
    expect(lists[0].searchParams.get("cursor")).toBe("bex_cursor");
    expect(lists[1].search).toBe(""); // no cursor, no limit: nothing invented
    expect(calls(mock, EXPERIMENTS).find((call) => call.method === "POST")?.body).toEqual({
      suite_id: "catalog",
      arm_ids: ["parallel"],
    });
    expect(calls(mock, `${EXPERIMENTS}/${ID}/cancel`)).toEqual([{ method: "POST", body: null }]);
  });

  it("encode experiment ids in paths", async () => {
    const mock = stubFetch(() => json(experimentDetail()));
    await api.getBenchmarkExperiment("bex/../x?y");
    expect(String(mock.mock.calls[0][0])).toContain("/api/benchmarks/experiments/bex%2F..%2Fx%3Fy");
  });

  it.each([
    [400, { detail: "suite 'catalog' has no task 'x'" }, "suite 'catalog' has no task 'x'"],
    [403, { detail: "creating benchmark experiments is not available in the public demo" }, "not available in the public demo"],
    [404, { detail: `experiment ${ID} not found` }, "not found"],
    [409, { detail: "experiment bex_1 is running; only one experiment may be active" }, "only one experiment may be active"],
    [422, { detail: [{ loc: ["body", "repetitions"], msg: "Input should be less than or equal to 10" }] }, "repetitions: Input should be less than or equal to 10"],
  ])("turn a %i into an ApiError with the server's reason", async (status, body, message) => {
    stubFetch(() => json(body, status));
    const error = await api.createBenchmarkExperiment({ suite_id: "catalog", arm_ids: ["parallel"] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
    expect((error as ApiError).message).toContain(message);
  });

  it("pass network failures through untouched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(api.benchmarkSuites()).rejects.toBeInstanceOf(TypeError);
  });
});

// ----------------------------------------------------------------------
// keys and polling rules
// ----------------------------------------------------------------------
describe("benchmark query keys and polling rules", () => {
  it("live under one benchmarks prefix", () => {
    expect(benchmarkKeys.suites).toEqual(["benchmarks", "suites"]);
    expect(benchmarkKeys.experimentList(20)).toEqual(["benchmarks", "experiments", { limit: 20 }]);
    expect(benchmarkKeys.experiment(ID)).toEqual(["benchmarks", "experiment", ID]);
    for (const key of [benchmarkKeys.suites, benchmarkKeys.experimentList(5), benchmarkKeys.experiment(ID)]) {
      expect(key[0]).toBe(benchmarkKeys.all[0]);
    }
    expect(benchmarkKeys.experimentList(5).slice(0, 2)).toEqual([...benchmarkKeys.experimentLists]);
  });

  it.each<[BenchmarkExperimentStatus, number | false]>([
    ["queued", BENCHMARK_POLL_MS],
    ["running", BENCHMARK_POLL_MS],
    ["completed", false],
    ["partial", false],
    ["cancelled", false],
    ["failed", false],
    ["interrupted", false],
  ])("poll a %s experiment: %s", (status, interval) => {
    expect(experimentPollInterval(status)).toBe(interval);
    expect(isActiveExperiment(status)).toBe(interval !== false);
  });

  it("refresh a list while any loaded experiment is active, and only then", () => {
    const pages = (...statuses: BenchmarkExperimentStatus[][]) => ({
      pages: statuses.map((page) => experimentPage(page.map((status, i) => experimentSummary({ experiment_id: `bex_${status}_${i}`, status })))),
      pageParams: statuses.map(() => null),
    });
    expect(experimentListPollInterval(undefined)).toBe(false);
    expect(experimentListPollInterval(pages([]))).toBe(false);
    expect(experimentListPollInterval(pages(["completed", "failed"], ["interrupted"]))).toBe(false);
    expect(experimentListPollInterval(pages(["completed"], ["queued"]))).toBe(BENCHMARK_POLL_MS);
    expect(experimentListPollInterval(pages(["running"]))).toBe(BENCHMARK_POLL_MS);
  });

  it("list each experiment once, in page order", () => {
    const a = experimentSummary({ experiment_id: "bex_a" });
    const b = experimentSummary({ experiment_id: "bex_b" });
    const c = experimentSummary({ experiment_id: "bex_c" });
    const data = { pages: [experimentPage([a, b]), experimentPage([b, c])], pageParams: [null, "bex_b"] };
    expect(experimentsFromPages(data).map((e) => e.experiment_id)).toEqual(["bex_a", "bex_b", "bex_c"]);
    expect(experimentsFromPages(undefined)).toEqual([]);
  });

  it("do not poll before the status is known", () => {
    expect(experimentPollInterval(undefined)).toBe(false);
    expect(BENCHMARK_POLL_MS).toBe(2_000);
  });
});

// ----------------------------------------------------------------------
// hooks
// ----------------------------------------------------------------------
describe("benchmark hooks", () => {
  it("load the suites", async () => {
    stubFetch((url) => (url.pathname === "/api/benchmarks/suites" ? json(benchmarkSuites({ can_create: false })) : undefined));
    const { result } = renderHook(() => useBenchmarkSuites(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.can_create).toBe(false);
  });

  it("page experiments with the server's cursor", async () => {
    const first = experimentPage([experimentSummary({ experiment_id: "bex_3" }), experimentSummary({ experiment_id: "bex_2" })], "bex_2");
    const second = experimentPage([experimentSummary({ experiment_id: "bex_1" })], null);
    const mock = stubFetch((url) =>
      url.pathname === EXPERIMENTS ? json(url.searchParams.get("cursor") === "bex_2" ? second : first) : undefined,
    );
    const { result } = renderHook(() => useBenchmarkExperiments(2), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);

    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    const ids = result.current.data!.pages.flatMap((page) => page.experiments.map((e) => e.experiment_id));
    expect(ids).toEqual(["bex_3", "bex_2", "bex_1"]);
    expect(result.current.hasNextPage).toBe(false);
    const sent = requestsTo(mock, EXPERIMENTS);
    expect(sent.map((url) => [url.searchParams.get("limit"), url.searchParams.get("cursor")])).toEqual([
      ["2", null],
      ["2", "bex_2"],
    ]);
  });

  it("poll an active experiment every 2 seconds and stop once it is terminal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let served = 0;
    const statuses: BenchmarkExperimentStatus[] = ["queued", "running", "running", "completed"];
    const mock = stubFetch((url) => {
      if (url.pathname !== `${EXPERIMENTS}/${ID}`) return undefined;
      const status = statuses[Math.min(served, statuses.length - 1)];
      served += 1;
      return json(experimentDetail({ status }));
    });
    const { result } = renderHook(() => useBenchmarkExperiment(ID), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.experiment.status).toBe("queued"));
    expect(requestsTo(mock, `${EXPERIMENTS}/${ID}`)).toHaveLength(1);

    await act(() => vi.advanceTimersByTimeAsync(BENCHMARK_POLL_MS - 100));
    expect(requestsTo(mock, `${EXPERIMENTS}/${ID}`)).toHaveLength(1); // not before 2 s
    for (const expected of ["running", "running", "completed"]) {
      await act(() => vi.advanceTimersByTimeAsync(BENCHMARK_POLL_MS));
      await waitFor(() => expect(result.current.data?.experiment.status).toBe(expected));
    }
    const atCompletion = requestsTo(mock, `${EXPERIMENTS}/${ID}`).length;
    expect(atCompletion).toBe(4);

    await act(() => vi.advanceTimersByTimeAsync(BENCHMARK_POLL_MS * 10));
    expect(requestsTo(mock, `${EXPERIMENTS}/${ID}`)).toHaveLength(atCompletion);
  });

  it.each<BenchmarkExperimentStatus>(["completed", "partial", "cancelled", "failed", "interrupted"])(
    "never poll a %s experiment",
    async (status) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const mock = stubFetch((url) => (url.pathname === `${EXPERIMENTS}/${ID}` ? json(experimentDetail({ status })) : undefined));
      const { result } = renderHook(() => useBenchmarkExperiment(ID), { wrapper: wrapper() });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      await act(() => vi.advanceTimersByTimeAsync(BENCHMARK_POLL_MS * 5));
      expect(requestsTo(mock, `${EXPERIMENTS}/${ID}`)).toHaveLength(1);
    },
  );

  it("do not retry or poll a missing experiment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mock = stubFetch(() => json({ detail: `experiment ${ID} not found` }, 404));
    const { result } = renderHook(() => useBenchmarkExperiment(ID), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).status).toBe(404);
    await act(() => vi.advanceTimersByTimeAsync(BENCHMARK_POLL_MS * 5));
    expect(requestsTo(mock, `${EXPERIMENTS}/${ID}`)).toHaveLength(1);
  });

  it("fetch nothing without an experiment id", () => {
    const mock = stubFetch(() => undefined);
    renderHook(() => useBenchmarkExperiment(undefined), { wrapper: wrapper() });
    expect(mock).not.toHaveBeenCalled();
  });

  it("cache a created experiment and refresh every experiment list", async () => {
    const created = experimentDetail({ experiment_id: "bex_new", status: "queued" });
    const mock = stubFetch((url, init) => {
      if (url.pathname === EXPERIMENTS && init?.method === "POST") return json(created, 202);
      if (url.pathname === EXPERIMENTS) return json(experimentPage([]));
      return undefined;
    });
    const client = createQueryClient();
    const { result } = renderHook(() => ({ list: useBenchmarkExperiments(20), create: useCreateBenchmarkExperiment() }), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    const before = calls(mock, EXPERIMENTS).filter((call) => call.method === "GET").length;

    await act(() => result.current.create.mutateAsync({ suite_id: "catalog", arm_ids: ["parallel"], repetitions: 2 }));

    expect(client.getQueryData(benchmarkKeys.experiment("bex_new"))).toEqual(created);
    await waitFor(() => expect(calls(mock, EXPERIMENTS).filter((call) => call.method === "GET").length).toBe(before + 1));
    expect(calls(mock, EXPERIMENTS).filter((call) => call.method === "POST")).toEqual([
      { method: "POST", body: { suite_id: "catalog", arm_ids: ["parallel"], repetitions: 2 } },
    ]);
  });

  it("never retry a refused creation, and change nothing in the cache", async () => {
    const mock = stubFetch(() => json({ detail: "experiment bex_1 is running; only one experiment may be active" }, 409));
    const client = createQueryClient();
    const { result } = renderHook(() => useCreateBenchmarkExperiment(), { wrapper: wrapper(client) });
    await act(() => result.current.mutateAsync({ suite_id: "catalog", arm_ids: ["parallel"] }).catch(() => undefined));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).status).toBe(409);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(client.getQueryCache().findAll({ queryKey: benchmarkKeys.all })).toHaveLength(0);
  });

  it.each([
    [202, { experiment_id: ID, status: "cancelling" }],
    [409, { detail: `experiment ${ID} already finished: completed` }],
  ])("refresh the experiment and the lists after a cancel answered %i", async (status, body) => {
    const mock = stubFetch((url) => {
      if (url.pathname === `${EXPERIMENTS}/${ID}/cancel`) return json(body, status);
      if (url.pathname === `${EXPERIMENTS}/${ID}`) return json(experimentDetail({ status: "running" }));
      if (url.pathname === EXPERIMENTS) return json(experimentPage([experimentSummary()]));
      return undefined;
    });
    const { result } = renderHook(
      () => ({ detail: useBenchmarkExperiment(ID), list: useBenchmarkExperiments(20), cancel: useCancelBenchmarkExperiment() }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.detail.isSuccess && result.current.list.isSuccess).toBe(true));
    const detailBefore = requestsTo(mock, `${EXPERIMENTS}/${ID}`).length;
    const listBefore = requestsTo(mock, EXPERIMENTS).length;

    await act(() => result.current.cancel.mutateAsync(ID).catch(() => undefined));

    await waitFor(() => expect(requestsTo(mock, `${EXPERIMENTS}/${ID}`).length).toBeGreaterThan(detailBefore));
    await waitFor(() => expect(requestsTo(mock, EXPERIMENTS).length).toBeGreaterThan(listBefore));
    expect(calls(mock, `${EXPERIMENTS}/${ID}/cancel`)).toHaveLength(1); // no automatic retry
    expect(result.current.cancel.isError).toBe(status !== 202);
  });
});
