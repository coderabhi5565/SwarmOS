import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { replay } from "@/domain/execution";
import { fixtures } from "@/domain/execution/fixtures";
import { ExecutionTimeline } from "./ExecutionTimeline";

describe("ExecutionTimeline", () => {
  it("never animates past events, so history does not look live", () => {
    const state = replay(fixtures.demoPipelineCompleted.events);
    const { container } = render(<ExecutionTimeline events={state.log} />);
    expect(screen.getAllByText("started").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
  });

  it("is a polite live region only while the run is live", () => {
    const state = replay(fixtures.demoPipelineCompleted.events);
    const { rerender } = render(<ExecutionTimeline events={state.log} />);
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    rerender(<ExecutionTimeline events={state.log} live />);
    expect(screen.getByRole("log")).toHaveAttribute("aria-live", "polite");
  });
});
