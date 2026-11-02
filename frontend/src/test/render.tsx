import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Providers } from "@/app/providers";
import { routes } from "@/app/router";
// The app's pages are lazy routes. Importing them here loads and compiles them
// while the test file is collected, outside any test's timeout, so a test's
// first render never also waits for a page module to compile (which on a
// slow or busy machine can take several seconds). The router's lazy import
// then resolves from the module cache.
import "@/pages/BenchmarksPage";
import "@/pages/ConsolePage";
import "@/pages/HistoryPage";
import "@/pages/LegacyPage";
import "@/pages/NewRunPage";
import "@/pages/RunPage";

/** Render the real route table at `path`, with the app's providers. */
export function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { ...view, router };
}
