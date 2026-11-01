import { createBrowserRouter, type RouteObject } from "react-router";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { AppShell, type RouteHandle } from "./layout/AppShell";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <OverviewPage /> },
      // Loaded on demand, so the overview does not ship the legacy dashboard.
      {
        path: "console",
        handle: { fullBleed: true } satisfies RouteHandle,
        lazy: async () => ({ Component: (await import("@/pages/ConsolePage")).ConsolePage }),
      },
      {
        path: "runs/new",
        lazy: async () => ({ Component: (await import("@/pages/NewRunPage")).NewRunPage }),
      },
      {
        path: "runs/:runId",
        lazy: async () => ({ Component: (await import("@/pages/RunPage")).RunPage }),
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export function createRouter() {
  return createBrowserRouter(routes);
}
