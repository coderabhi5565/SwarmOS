import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BenchmarkSuites, Health } from "@/api/types";
import { json, stubFetch } from "@/test/api";
import { benchmarkSuites, experimentDetail, experimentPage } from "@/test/benchmarks";
import { renderAt } from "@/test/render";

const EXPERIMENTS = "/api/benchmarks/experiments";

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

/** Server options with names no frontend could hardcode. */
function suites(overrides: Partial<BenchmarkSuites> = {}): BenchmarkSuites {
  const base = benchmarkSuites();
  return {
    ...base,
    max_repetitions: 4,
    max_trials: 12,
    suites: [
      ...base.suites,
      {
        id: "zz-real-suite",
        title: "Server-defined real suite",
        description: "Free-form goals.",
        version: "v1-aaaaaaaaaaaa",
        public: false,
        requires_real_model: true,
        tasks: [{ id: "zz_task", title: "Server task", demo_task: null, parallel_waves: null, notes: "" }],
      },
    ],
    arms: [
      ...base.arms,
      { id: "zz-arm", kind: "model_policy", label: "Server-only arm", description: "from the server", model_policy: "adaptive", parallel_coding: null, max_escalations: 1 },
    ],
    ...overrides,
  };
}

type Answer = Response | (() => Response | Promise<Response>);

/** Serve health, suites and the list; answer POSTs with `post` (and record them). */
function serve({ options = suites(), post }: { options?: BenchmarkSuites; post?: Answer } = {}) {
  const posts: unknown[] = [];
  const mock = stubFetch((url, init) => {
    if (url.pathname === "/health") return json(health);
    if (url.pathname === "/api/benchmarks/suites") return json(options);
    if (url.pathname === EXPERIMENTS && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      if (!post) return json({ detail: "unexpected POST" }, 500);
      return typeof post === "function" ? post() : post.clone();
    }
    if (url.pathname === EXPERIMENTS) return json(experimentPage([]));
    return undefined;
  });
  return { mock, posts };
}

const form = () => screen.getByRole("form", { name: "New experiment" });
const start = () => within(form()).getByRole("button", { name: /Start experiment|Starting/ });
const check = (name: RegExp) => userEvent.click(within(form()).getByRole("checkbox", { name }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("experiment creation", () => {
  it("offers exactly the server's suites, tasks, arms and caps", async () => {
    serve();
    renderAt("/benchmarks");
    await screen.findByRole("form", { name: "New experiment" });

    const suiteChoices = within(form()).getAllByRole("radio");
    expect(suiteChoices.map((radio) => (radio as HTMLInputElement).value)).toEqual(["catalog", "zz-real-suite"]);
    expect(within(form()).getByText("v1-aaaaaaaaaaaa")).toBeInTheDocument();
    expect(within(form()).getByText("needs a real model")).toBeInTheDocument();
    // The first suite's tasks, all chosen by default.
    const tasks = within(within(form()).getByRole("group", { name: "Tasks" })).getAllByRole("checkbox");
    expect(tasks).toHaveLength(2);
    expect(tasks.every((box) => (box as HTMLInputElement).checked)).toBe(true);
    // Every server arm, including one only the server knows about; none chosen.
    const arms = within(within(form()).getByRole("group", { name: "Arms" })).getAllByRole("checkbox");
    expect(arms).toHaveLength(3);
    expect(within(form()).getByText("Server-only arm")).toBeInTheDocument();
    expect(arms.some((box) => (box as HTMLInputElement).checked)).toBe(false);
    expect(within(form()).getByRole("spinbutton", { name: "Repetitions" })).toHaveAttribute("max", "4");
    expect(within(form()).getByText(/at most 12/)).toBeInTheDocument();
    const providers = within(within(form()).getByRole("combobox", { name: "Provider" })).getAllByRole("option");
    expect(providers.map((option) => (option as HTMLOptionElement).value)).toEqual(["auto", "demo", "openai"]);
    // No goal, file, model, endpoint or limit field exists.
    expect(within(form()).queryByRole("textbox", { name: /goal|model|url|endpoint|limit/i })).not.toBeInTheDocument();
  });

  it("switching suites offers that suite's tasks", async () => {
    serve();
    renderAt("/benchmarks");
    await screen.findByRole("form", { name: "New experiment" });
    await userEvent.click(within(form()).getByRole("radio", { name: /Server-defined real suite/ }));
    const tasks = within(within(form()).getByRole("group", { name: "Tasks" })).getAllByRole("checkbox");
    expect(tasks).toHaveLength(1);
    expect(within(form()).getByText("zz_task")).toBeInTheDocument();
  });

  it("is not shown, and sends nothing, when the server does not accept experiments", async () => {
    const { mock, posts } = serve({ options: suites({ can_create: false }) });
    renderAt("/benchmarks");
    expect(await screen.findByRole("note", { name: "Read-only" })).toHaveTextContent("does not accept new experiments");
    expect(screen.queryByRole("form", { name: "New experiment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start experiment/ })).not.toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(posts).toEqual([]);
    expect(mock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("explains what is missing and sends nothing until it is fixed", async () => {
    const { posts } = serve();
    renderAt("/benchmarks");
    await screen.findByRole("form", { name: "New experiment" });

    await userEvent.click(start());
    expect(within(form()).getByText("Choose at least one arm.")).toBeInTheDocument();

    await check(/Parallel coding/);
    for (const task of within(within(form()).getByRole("group", { name: "Tasks" })).getAllByRole("checkbox")) {
      await userEvent.click(task);
    }
    await userEvent.click(start());
    expect(within(form()).getByText("Choose at least one task.")).toBeInTheDocument();
    await check(/Tag normalization/);

    const repetitions = within(form()).getByRole("spinbutton", { name: "Repetitions" });
    fireEvent.change(repetitions, { target: { value: "5" } });
    await userEvent.click(start());
    expect(within(form()).getByText("Repetitions must be a whole number from 1 to 4.")).toBeInTheDocument();
    expect(repetitions).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(repetitions, { target: { value: "1" } });

    await userEvent.type(within(form()).getByRole("textbox", { name: /Order seed/ }), "-3");
    await userEvent.click(start());
    expect(within(form()).getByText(/The seed must be a whole number/)).toBeInTheDocument();

    expect(posts).toEqual([]);
  });

  it("refuses more trials than the server allows", async () => {
    const { posts } = serve();
    renderAt("/benchmarks");
    await screen.findByRole("form", { name: "New experiment" });
    await check(/Parallel coding/);
    await check(/Sequential coding/);
    await check(/Server-only arm/);
    fireEvent.change(within(form()).getByRole("spinbutton", { name: "Repetitions" }), { target: { value: "3" } });
    await userEvent.click(start()); // 3 arms x 2 tasks x 3 = 18 > 12
    expect(within(form()).getByText("18 trials requested; this server allows at most 12.")).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it("will not ask the demo fixture for a suite that needs a real model", async () => {
    const { posts } = serve();
    renderAt("/benchmarks");
    await screen.findByRole("form", { name: "New experiment" });
    await userEvent.click(within(form()).getByRole("radio", { name: /Server-defined real suite/ }));
    await check(/Server-only arm/);
    await userEvent.selectOptions(within(form()).getByRole("combobox", { name: "Provider" }), "demo");
    await userEvent.click(start());
    expect(within(form()).getByText(/needs a real model: the demo fixture only scripts/)).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it("sends only the chosen fixed options, then opens the new experiment", async () => {
    const created = experimentDetail({ experiment_id: "bex_new", status: "queued" });
    const { posts } = serve({ post: json(created, 202) });
    const { router } = renderAt("/benchmarks");
    await screen.findByRole("form", { name: "New experiment" });

    await check(/Sequential coding/);
    await check(/Parallel coding/);
    await check(/Parallel pipeline/); // leave only the first task
    fireEvent.change(within(form()).getByRole("spinbutton", { name: "Repetitions" }), { target: { value: "2" } });
    await userEvent.selectOptions(within(form()).getByRole("combobox", { name: "Provider" }), "demo");
    await userEvent.type(within(form()).getByRole("textbox", { name: /Order seed/ }), "42");
    expect(within(form()).getByText(/^4 trials/)).toBeInTheDocument();
    await userEvent.click(start());

    await waitFor(() => expect(router.state.location.pathname).toBe("/benchmarks/bex_new"));
    expect(posts).toEqual([
      {
        suite_id: "catalog",
        arm_ids: ["sequential", "parallel"],
        repetitions: 2,
        provider: "demo",
        task_ids: ["sample_tag_normalization"],
        order_seed: 42,
      },
    ]);
  });

  it("leaves out task_ids and order_seed when all tasks are chosen and no seed is given", async () => {
    const { posts } = serve({ post: json(experimentDetail({ experiment_id: "bex_all" }), 202) });
    const { router } = renderAt("/benchmarks");
    await screen.findByRole("form", { name: "New experiment" });
    await check(/Parallel coding/);
    await userEvent.click(start());
    await waitFor(() => expect(router.state.location.pathname).toBe("/benchmarks/bex_all"));
    expect(posts).toEqual([{ suite_id: "catalog", arm_ids: ["parallel"], repetitions: 1, provider: "auto" }]);
  });

  it("sends once while a request is pending, however often it is submitted", async () => {
    let release: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { posts } = serve({ post: () => pending });
    const { router } = renderAt("/benchmarks");
    await screen.findByRole("form", { name: "New experiment" });
    await check(/Parallel coding/);

    await userEvent.click(start());
    await waitFor(() => expect(start()).toBeDisabled());
    expect(start()).toHaveTextContent("Starting…");
    fireEvent.submit(form()); // a keyboard submit while pending
    fireEvent.submit(form());
    expect(posts).toHaveLength(1);

    release(json(experimentDetail({ experiment_id: "bex_once" }), 202));
    await waitFor(() => expect(router.state.location.pathname).toBe("/benchmarks/bex_once"));
    expect(posts).toHaveLength(1);
  });

  it.each([
    [400, {}, { detail: "suite 'catalog' needs a real model" }, "The server refused this experiment.", "needs a real model"],
    [403, {}, { detail: "creating benchmark experiments is not available in the public demo" }, "This server does not accept new experiments.", "not available"],
    [409, {}, { detail: "experiment bex_1 is running; only one experiment may be active" }, "Another experiment is already active.", "only one experiment"],
    [422, {}, { detail: [{ loc: ["body", "repetitions"], msg: "Input should be less than or equal to 10" }] }, "The request was not valid.", "repetitions: Input should be"],
    [429, { "Retry-After": "30" }, { detail: "rate limited" }, "Busy right now. Try again in 30 s.", "rate limited"],
    [500, {}, { detail: "database unavailable" }, "The server failed to start the experiment.", "database unavailable"],
  ])("reports a %i and never retries it", async (status, headers, body, title, detail) => {
    const { posts } = serve({ post: json(body, status, headers) });
    const { router } = renderAt("/benchmarks");
    await screen.findByRole("form", { name: "New experiment" });
    await check(/Parallel coding/);
    await userEvent.click(start());

    const alert = await within(form()).findByRole("alert");
    expect(alert).toHaveTextContent(title);
    expect(alert).toHaveTextContent(detail);
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(posts).toHaveLength(1);
    expect(router.state.location.pathname).toBe("/benchmarks");
    expect(start()).not.toBeDisabled();
  });

  it("reports an unreachable server and does not retry", async () => {
    const { posts } = serve({ post: () => Promise.reject(new TypeError("Failed to fetch")) });
    renderAt("/benchmarks");
    await screen.findByRole("form", { name: "New experiment" });
    await check(/Parallel coding/);
    await userEvent.click(start());
    expect(await within(form()).findByRole("alert")).toHaveTextContent("Could not reach the server");
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(posts).toHaveLength(1);
  });

  it("clears a server error once the choices change", async () => {
    serve({ post: json({ detail: "only one experiment may be active" }, 409) });
    renderAt("/benchmarks");
    await screen.findByRole("form", { name: "New experiment" });
    await check(/Parallel coding/);
    await userEvent.click(start());
    await within(form()).findByRole("alert");
    await check(/Sequential coding/);
    expect(within(form()).queryByRole("alert")).not.toBeInTheDocument();
  });
});
