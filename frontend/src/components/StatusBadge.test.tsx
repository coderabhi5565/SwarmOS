import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "@/components/StatusBadge";
import { isTerminal, TERMINAL } from "@/types";

describe("run status", () => {
  it("treats only queued and running as live", () => {
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("running")).toBe(false);
    for (const status of TERMINAL) {
      expect(isTerminal(status)).toBe(true);
    }
  });

  it("classifies every status the backend can finish with", () => {
    expect([...TERMINAL].sort()).toEqual(
      [
        "budget_exceeded",
        "cancelled",
        "completed",
        "completed_with_findings",
        "failed",
        "limit_exceeded",
        "review_invalid",
        "timed_out",
      ].sort(),
    );
  });

  it("labels an invalid review distinctly from a failure", () => {
    render(<StatusBadge status="review_invalid" />);
    const badge = screen.getByText("invalid review");
    expect(badge).toHaveClass("badge", "status-review_invalid");
  });
});
