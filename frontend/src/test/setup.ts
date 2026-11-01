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

// React Flow measures its viewport and nodes; jsdom has no layout. These
// stand-ins (as React Flow's testing guide suggests) give it a fixed size.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class DOMMatrixReadOnlyStub {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
    this.m22 = scale !== undefined ? Number(scale) : 1;
  }
}

if (typeof window !== "undefined") {
  globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
  (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly ??= DOMMatrixReadOnlyStub;
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 800 },
    offsetHeight: { configurable: true, get: () => 480 },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
}
