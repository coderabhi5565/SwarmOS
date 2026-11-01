import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// Pages are lazy routes: the first render in a test file compiles and imports
// the page module, which under a full parallel run can exceed the 1 s default.
// findBy queries still resolve as soon as their element appears.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
});
