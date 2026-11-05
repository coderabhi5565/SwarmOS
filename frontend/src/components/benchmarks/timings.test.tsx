import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BenchmarkTimingAggregate, BenchmarkTimingSummary } from "@/api/types";
import { TIMING_GROUPS, TimingAggregateTable, formatTiming, measurementStatusText } from "./timings";

const summary = (overrides: Partial<BenchmarkTimingSummary> = {}): BenchmarkTimingSummary => ({
  n: 0,
  missing: 0,
  missing_reasons: {},
  median: null,
  p95: null,
  min: null,
  max: null,
  ...overrides,
});

const EVERY_FIELD = TIMING_GROUPS.flatMap((group) => group.rows.map((row) => row.field));

function aggregateTimings(overrides: Partial<BenchmarkTimingAggregate> = {}): BenchmarkTimingAggregate {
  return {
    measured: 3,
    unavailable: {},
    metrics: Object.fromEntries(EVERY_FIELD.map((field) => [field, summary({ missing: 3, missing_reasons: { "not established": 3 } })])),
    ...overrides,
  };
}

const row = (label: RegExp) => screen.getByRole("rowheader", { name: label }).closest("tr") as HTMLElement;
const cells = (label: RegExp) => within(row(label)).getAllByRole("cell").map((cell) => cell.textContent);

describe("formatTiming", () => {
  it.each([
    [0, "0.00 ms"],
    [0.42, "0.42 ms"],
    [5.24, "5.2 ms"],
    [340.4, "340 ms"],
    [1234, "1.23 s"],
    [12_345, "12.3 s"],
    [65_000, "1 min 5 s"],
  ])("%d ms reads %s", (ms, text) => {
    expect(formatTiming(ms)).toBe(text);
  });

  it("leaves a missing value missing, never zero", () => {
    expect(formatTiming(null)).toBeNull();
    expect(formatTiming(undefined)).toBeNull();
  });
});

describe("the catalogue of timing fields", () => {
  it("covers every trial timing field exactly once", () => {
    expect(new Set(EVERY_FIELD).size).toBe(EVERY_FIELD.length);
    expect(EVERY_FIELD).toHaveLength(28);
    expect(EVERY_FIELD).toContain("trial_slot_wait_ms");
  });

  it("words every measurement status", () => {
    expect(measurementStatusText("metrics_v1")).toBe("recorded before trial timings");
    expect(measurementStatusText("measurement_flush_failed")).toBe("measurements could not be saved");
    expect(measurementStatusText("something_new")).toBe("something new");
  });
});

describe("TimingAggregateTable", () => {
  it("shows n, missing, median, nearest-rank p95, min and max as the backend reports them", () => {
    const timings = aggregateTimings({
      metrics: {
        ...aggregateTimings().metrics,
        // Three measured trials: 100, 200 and 300 ms.
        lifecycle_ms: summary({ n: 3, median: 200, p95: 300, min: 100, max: 300 }),
        // Two established it; one did not, with its reason.
        planner_ms: summary({ n: 2, missing: 1, missing_reasons: { "no planner node ran": 1 }, median: 20, p95: 30, min: 10, max: 30 }),
        provider_calls: summary({ n: 3, median: 2, p95: 3, min: 1, max: 3 }),
      },
    });
    render(<TimingAggregateTable timings={timings} counted={3} />);
    expect(cells(/^lifecycle/)).toEqual(["3", "0", "200 ms", "300 ms", "100 ms", "300 ms"]);
    expect(cells(/^planner/)).toEqual(["2", "1", "20 ms", "30 ms", "10 ms", "30 ms"]);
    expect(row(/^planner/)).toHaveTextContent("missing: no planner node ran (1)");
    expect(cells(/^calls/)).toEqual(["3", "0", "2", "3", "1", "3"]); // a count, not a duration
    expect(screen.getByRole("columnheader", { name: "p95" })).toBeInTheDocument();
    expect(screen.getByTitle("nearest-rank 95th percentile: an observed value")).toBeInTheDocument();
  });

  it("never shows a missing statistic as zero", () => {
    render(<TimingAggregateTable timings={aggregateTimings()} counted={3} />);
    expect(cells(/^diagnostic verification/)).toEqual(["0", "3", "—", "—", "—", "—"]);
    expect(row(/^diagnostic verification/)).toHaveTextContent("missing: not established (3)");
    expect(within(row(/^diagnostic verification/)).queryByText(/0 ms/)).not.toBeInTheDocument();
  });

  it("labels busy sums, totals and unions for what they are", () => {
    render(<TimingAggregateTable timings={aggregateTimings()} counted={3} />);
    expect(row(/^coder busy/)).toHaveTextContent("busy: a sum, overlaps counted");
    expect(row(/^coder wall \(union\)/)).toHaveTextContent("elapsed");
    expect(row(/^step schedule delay/)).toHaveTextContent("total time spent, not elapsed");
  });

  it("counts unavailable trials by status and keeps them out of the figures", () => {
    const timings = aggregateTimings({ measured: 3, unavailable: { measurement_flush_failed: 1, metrics_v1: 1 } });
    render(<TimingAggregateTable timings={timings} counted={5} />);
    expect(screen.getByText(/have recorded run measurements/)).toHaveTextContent(
      "3 of 5 counted trials have recorded run measurements. The other 2 are left out of every timing figure: " +
        "measurements could not be saved (1); recorded before trial timings (1).",
    );
  });

  it("has nothing to tabulate when no trial was measured", () => {
    render(<TimingAggregateTable timings={{ measured: 0, unavailable: { metrics_v1: 2 }, metrics: {} }} counted={2} />);
    expect(screen.getByText("No timing figures: no counted trial has recorded run measurements.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(/left out of every timing figure/)).toHaveTextContent("recorded before trial timings (2)");
  });
});
