import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeNext } from "@/api/auth";
import type { AuthUser, DemoTasks, Health, Me } from "@/api/types";
import { json, requestsTo, stubFetch, type Route } from "@/test/api";
import { benchmarkSuites, experimentPage } from "@/test/benchmarks";
import { renderAt } from "@/test/render";

/** A fresh password per test: none is written into the test source. */
const newPassword = () => `pw-${crypto.randomUUID()}`;

const health = (mode: Health["mode"]): Health => ({
  status: "ok",
  service: "swarmos",
  version: "0.3.0",
  mode,
  provider_mode: "auto",
  provider_kind: "demo",
  openai_configured: false,
  auth_required: false,
});

const user = (role: AuthUser["role"] = "user"): AuthUser => ({
  user_id: "usr_0123456789abcdef",
  full_name: role === "operator" ? "Olive Operator" : "Uma User",
  email: "uma@example.test",
  phone_masked: "*******2030",
  role,
});

const catalog: DemoTasks = {
  mode: "public_demo",
  tasks: [
    {
      id: "sample_tag_normalization",
      title: "Fix one function",
      description: "One coding step.",
      goal: "Implement normalize_tags.",
      steps: [{ id: "draft_implementation", title: "Implement", depends_on: [] }],
      waves: [["draft_implementation"]],
      allowed_files: ["target.py"],
      read_only_files: ["tests/test_target.py"],
      limits: { max_agent_calls: 6, max_budget_usd: 0.25, max_wall_seconds: 120, max_retries: 0, max_revisions: 1, max_escalations: 0, parallel_coding: true },
    },
  ],
};

const suites = (can_create: boolean) => benchmarkSuites({ mode: "public_demo", can_create });

/**
 * A public-demo server holding one session in memory: login and register
 * sign in, logout signs out, and /api/auth/me reports the current state.
 */
function serve({ signedIn = null as AuthUser | null, mode = "public_demo" as Health["mode"], extra = (() => undefined) as Route } = {}) {
  let current = signedIn;
  const me = (): Me => ({ authenticated: current !== null, user: current, mode });
  const mock = stubFetch((url, init) => {
    if (url.pathname === "/health") return json(health(mode));
    if (url.pathname === "/api/auth/me") return json(me());
    if (url.pathname === "/api/auth/logout" && init?.method === "POST") {
      current = null;
      return json({ authenticated: false, user: null });
    }
    if (url.pathname === "/api/demo-tasks") return json(catalog);
    if (url.pathname === "/api/benchmarks/experiments") return json(experimentPage([]));
    if (url.pathname === "/api/benchmarks/suites") return json(suites(current?.role === "operator"));
    return extra(url, init);
  });
  return { mock, signIn: (account: AuthUser) => (current = account) };
}

/** The header's account area, once the app has rendered it. */
const account = () => screen.findByRole("group", { name: "Account" });
const bodyOf = (mock: ReturnType<typeof stubFetch>, path: string) => {
  const call = mock.mock.calls.find(([input]) => new URL(String(input), "http://localhost").pathname === path);
  return call ? (JSON.parse(String(call[1]?.body)) as Record<string, string>) : null;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("account controls in the header", () => {
  it("offers sign-in and registration to a visitor, returning to the current page", async () => {
    serve();
    renderAt("/history");
    const signIn = await within(await account()).findByRole("link", { name: "Sign in" });
    expect(signIn).toHaveAttribute("href", "/login?next=%2Fhistory");
    expect(within(await account()).getByRole("link", { name: "Register" })).toHaveAttribute("href", "/register?next=%2Fhistory");
  });

  it("shows a signed-in user's name and role, and signs out", async () => {
    const { mock } = serve({ signedIn: user("user") });
    const { router } = renderAt("/history");
    expect(await within(await account()).findByLabelText("Signed in as Uma User, User")).toBeInTheDocument();
    expect(within(await account()).queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();

    await userEvent.click(within(await account()).getByRole("button", { name: "Sign out" }));
    expect(await within(await account()).findByRole("link", { name: "Sign in" })).toBeInTheDocument();
    expect(requestsTo(mock, "/api/auth/logout")).toHaveLength(1);
    expect(router.state.location.pathname).toBe("/");
  });

  it("marks an operator as such", async () => {
    serve({ signedIn: user("operator") });
    renderAt("/history");
    expect(await within(await account()).findByLabelText("Signed in as Olive Operator, Operator")).toBeInTheDocument();
  });

  it("reads an unreachable account endpoint as signed out, not as an error", async () => {
    stubFetch((url) => (url.pathname === "/health" ? json(health("public_demo")) : undefined));
    renderAt("/history");
    expect(await within(await account()).findByRole("link", { name: "Sign in" })).toBeInTheDocument();
  });

  it("sends the session cookie with every API request", async () => {
    const { mock } = serve();
    renderAt("/history");
    await within(await account()).findByRole("link", { name: "Sign in" });
    expect(mock.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of mock.mock.calls) expect(init?.credentials).toBe("include");
  });
});

describe("sign-in page", () => {
  it("signs in with an email or phone and returns to `next`", async () => {
    const password = newPassword();
    const { mock, signIn } = serve({
      extra: (url, init) => {
        if (url.pathname !== "/api/auth/login" || init?.method !== "POST") return undefined;
        signIn(user());
        return json({ authenticated: true, user: user() });
      },
    });
    const { router } = renderAt("/login?next=%2Fhistory");
    await userEvent.type(await screen.findByLabelText("Email or phone"), "  +1 555 010 2030 ");
    await userEvent.type(screen.getByLabelText("Password"), password);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/history"));
    expect(bodyOf(mock, "/api/auth/login")).toEqual({ identifier: "+1 555 010 2030", password });
    expect(await within(await account()).findByLabelText("Signed in as Uma User, User")).toBeInTheDocument();
  });

  it("says when the credentials are wrong, and stays", async () => {
    serve({
      extra: (url) =>
        url.pathname === "/api/auth/login" ? json({ detail: "incorrect email, phone or password" }, 401) : undefined,
    });
    const { router } = renderAt("/login");
    await userEvent.type(await screen.findByLabelText("Email or phone"), "uma@example.test");
    await userEvent.type(screen.getByLabelText("Password"), newPassword());
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email, phone or password.");
    expect(router.state.location.pathname).toBe("/login");
  });

  it("asks for both fields before sending anything", async () => {
    const { mock } = serve();
    renderAt("/login");
    await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(screen.getByText("Enter your email or phone number.")).toBeInTheDocument();
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();
    expect(requestsTo(mock, "/api/auth/login")).toHaveLength(0);
  });

  it("explains that accounts are ephemeral", async () => {
    serve();
    renderAt("/login");
    expect(await screen.findByRole("note")).toHaveTextContent("ephemeral SQLite database");
  });
});

describe("registration page", () => {
  it("checks each field before sending anything", async () => {
    const { mock } = serve();
    renderAt("/register");
    await userEvent.type(await screen.findByLabelText("Email"), "not-an-email");
    await userEvent.type(screen.getByLabelText("Phone"), "12345");
    await userEvent.type(screen.getByLabelText("Password"), "short");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByText("Enter your name.")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Enter 10 to 15 digits, optionally starting with +.")).toBeInTheDocument();
    expect(screen.getByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(screen.getByLabelText("Phone")).toHaveAttribute("aria-invalid", "true");
    expect(requestsTo(mock, "/api/auth/register")).toHaveLength(0);
  });

  it("registers, signs in and goes on to start a run", async () => {
    const password = newPassword();
    const { mock, signIn } = serve({
      extra: (url, init) => {
        if (url.pathname !== "/api/auth/register" || init?.method !== "POST") return undefined;
        signIn(user());
        return json({ authenticated: true, user: user() }, 201);
      },
    });
    const { router } = renderAt("/register");
    await userEvent.type(await screen.findByLabelText("Full name"), "Uma User");
    await userEvent.type(screen.getByLabelText("Email"), "uma@example.test");
    await userEvent.type(screen.getByLabelText("Phone"), "+1 555 010 2030");
    await userEvent.type(screen.getByLabelText("Password"), password);
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/runs/new"));
    expect(bodyOf(mock, "/api/auth/register")).toEqual({
      full_name: "Uma User",
      email: "uma@example.test",
      phone: "+1 555 010 2030",
      password,
    });
    expect(await screen.findByRole("button", { name: /Start run/ })).toBeInTheDocument();
  });

  it("shows the server's reason for a conflict", async () => {
    serve({
      extra: (url) =>
        url.pathname === "/api/auth/register" ? json({ detail: "an account with this phone already exists" }, 409) : undefined,
    });
    renderAt("/register");
    await userEvent.type(await screen.findByLabelText("Full name"), "Uma User");
    await userEvent.type(screen.getByLabelText("Email"), "uma@example.test");
    await userEvent.type(screen.getByLabelText("Phone"), "+1 555 010 2030");
    await userEvent.type(screen.getByLabelText("Password"), newPassword());
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("An account with this phone already exists.");
  });
});

describe("role-aware forms in the public demo", () => {
  it("asks a visitor to sign in before starting a run, but still shows the catalog", async () => {
    serve();
    renderAt("/runs/new");
    expect(await screen.findByRole("radio", { name: /Fix one function/ })).toBeInTheDocument();
    const prompt = await screen.findByRole("region", { name: "Sign in to start a run" });
    expect(within(prompt).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login?next=%2Fruns%2Fnew");
    expect(screen.queryByRole("button", { name: /Start run/ })).not.toBeInTheDocument();
  });

  it("lets a signed-in user start a run", async () => {
    serve({ signedIn: user() });
    renderAt("/runs/new");
    expect(await screen.findByRole("button", { name: /Start run/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sign in to start a run" })).not.toBeInTheDocument();
  });

  it("needs no account in local mode", async () => {
    serve({ mode: "local" });
    renderAt("/runs/new");
    expect(await screen.findByRole("button", { name: /Start run/ })).toBeInTheDocument();
  });

  it("tells a visitor that experiments are for operators, with a way to sign in", async () => {
    serve();
    renderAt("/benchmarks");
    const prompt = await screen.findByRole("region", { name: "Operators start experiments" });
    expect(within(prompt).getByRole("link", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("tells a signed-in user that only operators start experiments", async () => {
    serve({ signedIn: user("user") });
    renderAt("/benchmarks");
    const prompt = await screen.findByRole("region", { name: "Experiments are for operators" });
    expect(within(prompt).queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("shows an operator the experiment form", async () => {
    serve({ signedIn: user("operator") });
    renderAt("/benchmarks");
    expect(await screen.findByRole("button", { name: /Start experiment/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /operators/i })).not.toBeInTheDocument();
  });
});

describe("safeNext", () => {
  it("keeps paths inside the app and ignores anything else", () => {
    expect(safeNext("/runs/abc?x=1")).toBe("/runs/abc?x=1");
    expect(safeNext(null)).toBe("/runs/new");
    expect(safeNext("//elsewhere.test/path")).toBe("/runs/new");
    expect(safeNext("/\\elsewhere.test")).toBe("/runs/new");
    expect(safeNext("javascript:alert(1)")).toBe("/runs/new");
    expect(safeNext("history")).toBe("/runs/new");
  });
});
