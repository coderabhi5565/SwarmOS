import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PhaseTicker, TICKER } from "./PhaseTicker";
import { PHASES } from "./simulation";

describe("PhaseTicker", () => {
  const items = () => within(screen.getByRole("list", { name: "Pipeline" })).getAllByRole("listitem");

  it("has one entry per phase of the execution cycle, in order", () => {
    expect(TICKER.map((item) => item.phase)).toEqual(PHASES.map((phase) => phase.id));
    expect(TICKER.map((item) => item.label)).toEqual(["PLANNER", "3× CODER WAVE", "EVIDENCE GUARD", "PYTEST"]);
  });

  it.each(TICKER.map((item, index) => [item.phase, index] as const))("lights only the %s stage", (phase, index) => {
    render(<PhaseTicker phase={phase} />);
    expect(items().map((item) => item.getAttribute("aria-current"))).toEqual(TICKER.map((_, i) => (i === index ? "step" : null)));
  });

  it("lights nothing when there is no cycle to follow", () => {
    render(<PhaseTicker phase={null} />);
    expect(items().every((item) => !item.hasAttribute("aria-current"))).toBe(true);
    expect(screen.getByRole("list", { name: "Pipeline" })).toHaveTextContent("PLANNER→3× CODER WAVE→EVIDENCE GUARD→PYTEST");
  });
});
