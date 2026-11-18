import { createBrowserRouter, type RouteObject } from "react-router";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { AppShell, type RouteHandle } from "./layout/AppShell";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      {
        // The public front page; its 3D hero is a further lazy chunk.
        index: true,
        handle: { fullBleed: true } satisfies RouteHandle,
        lazy: async () => ({ Component: (await import("@/pages/LandingPage")).LandingPage }),
      },
      { path: "app", element: <OverviewPage /> },
      // Pages load on demand, so the overview ships only what it needs.
      {
        path: "console",
        lazy: async () => ({ Component: (await import("@/pages/ConsolePage")).ConsolePage }),
      },
      {
        // The pre-redesign dashboard: a local-development tool.
        path: "legacy",
        handle: { fullBleed: true } satisfies RouteHandle,
        lazy: async () => ({ Component: (await import("@/pages/LegacyPage")).LegacyPage }),
      },
      {
        path: "runs/new",
        lazy: async () => ({ Component: (await import("@/pages/NewRunPage")).NewRunPage }),
      },
      {
        path: "runs/:runId",
        lazy: async () => ({ Component: (await import("@/pages/RunPage")).RunPage }),
      },
      {
        path: "history",
        lazy: async () => ({ Component: (await import("@/pages/HistoryPage")).HistoryPage }),
      },
      {
        // Read-only in the public demo; creation comes from the server's can_create.
        path: "benchmarks",
        lazy: async () => ({ Component: (await import("@/pages/BenchmarksPage")).BenchmarksPage }),
      },
      {
        path: "benchmarks/:experimentId",
        lazy: async () => ({
          Component: (await import("@/pages/BenchmarkExperimentPage")).BenchmarkExperimentPage,
        }),
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export function createRouter() {
  return createBrowserRouter(routes);
}
