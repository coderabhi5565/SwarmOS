import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { domAnimation, LazyMotion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceGuardDemo, SandboxChecks, SpanWaterfall, WaveGantt } from "./ArchitectureWidgets";
import { BeamDiagram } from "./BeamDiagram";
import { Reveal, ScrollProgress } from "./Reveal";
import { WALKTHROUGH } from "./traceWalkthrough";

/** The app's motion setup; `reduce` forces what the OS setting would. */
function withMotion(ui: ReactNode, reduce = false) {
  return render(
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion={reduce ? "always" : "never"}>{ui}</MotionConfig>
    </LazyMotion>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WaveGantt", () => {
  it("starts a wave's three steps together and queues them when sequential", () => {
    withMotion(<WaveGantt />);
    const starts = (name: RegExp) =>
      [...screen.getByRole("group", { name }).querySelectorAll<HTMLElement>("[data-lane]")].map((bar) => bar.style.left);
    expect(starts(/parallel wave/)).toEqual(["0%", "0%", "0%"]);
    expect(starts(/sequential/).map((left) => Math.round(parseFloat(left)))).toEqual([0, 33, 67]);
    const lanes = [...screen.getByRole("group", { name: /parallel wave/ }).querySelectorAll("[data-lane]")];
    expect(lanes.map((lane) => lane.getAttribute("data-lane"))).toEqual(["inspect_tests", "draft_implementation", "document_change"]);
    expect(screen.getByRole("figure")).toHaveTextContent("Schedule shape, not a measurement.");
  });
});

describe("EvidenceGuardDemo", () => {
  const outcome = () => screen.getByRole("status", { name: "Guard outcome" });

  it("rejects a blocker without evidence as review_invalid", () => {
    withMotion(<EvidenceGuardDemo />);
    expect(screen.getByRole("radio", { name: "Blocker, no evidence" })).toHaveAttribute("aria-checked", "true");
    expect(outcome()).toHaveTextContent("guard → review_invalid");
    expect(outcome()).toHaveTextContent("it is never an approval");
  });

  it("lets a blocker that cites a file and line stand as request_changes", async () => {
    withMotion(<EvidenceGuardDemo />);
    await userEvent.click(screen.getByRole("radio", { name: "Blocker, file + line cited" }));
    expect(screen.getByRole("radio", { name: "Blocker, file + line cited" })).toHaveAttribute("aria-checked", "true");
    expect(await screen.findByText("guard → request_changes")).toBeInTheDocument();
    expect(outcome()).toHaveTextContent('file: "target.py" line: 12');
    expect(outcome()).not.toHaveTextContent("review_invalid");
    await userEvent.click(screen.getByRole("radio", { name: "Blocker, no evidence" }));
    expect(await screen.findByText("guard → review_invalid")).toBeInTheDocument();
  });

  it("is operable from the keyboard and says its findings are examples", async () => {
    withMotion(<EvidenceGuardDemo />);
    screen.getByRole("radio", { name: "Blocker, file + line cited" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText("guard → request_changes")).toBeInTheDocument();
    expect(screen.getByText("Example findings, not from a recorded run.")).toBeInTheDocument();
  });
});

describe("SpanWaterfall", () => {
  it("nests the run's spans inside the lifecycle, on perf_counter_ns", () => {
    withMotion(<SpanWaterfall />);
    const figure = screen.getByRole("figure");
    const spans = [...figure.querySelectorAll<HTMLElement>("[data-span]")];
    expect(spans.map((span) => span.getAttribute("data-span"))).toEqual([
      "lifecycle",
      "admission",
      "setup",
      "graph",
      "verify.process",
      "finalization",
    ]);
    const box = (name: string) => {
      const style = spans.find((span) => span.getAttribute("data-span") === name)!.style;
      return [parseFloat(style.left), parseFloat(style.left) + parseFloat(style.width)];
    };
    const [start, end] = box("lifecycle");
    for (const span of spans) {
      const [left, right] = box(span.getAttribute("data-span")!);
      expect(left).toBeGreaterThanOrEqual(start);
      expect(right).toBeLessThanOrEqual(end);
    }
    // Verification happens inside the graph; admission, setup and graph follow one another.
    expect(box("verify.process")[0]).toBeGreaterThanOrEqual(box("graph")[0]);
    expect(box("verify.process")[1]).toBeLessThanOrEqual(box("graph")[1]);
    expect(box("setup")[0]).toBe(box("admission")[1]);
    expect(box("graph")[0]).toBe(box("setup")[1]);
    expect(figure).toHaveTextContent("Offsets on perf_counter_ns. Not to scale.");
  });
});

describe("SandboxChecks", () => {
  const passed = () =>
    within(screen.getByRole("list", { name: "Public sandbox checks" }))
      .getAllByRole("listitem")
      .map((item) => item.getAttribute("data-passed") === "true");

  it("ticks the checks off one at a time, holds, then starts over", () => {
    vi.useFakeTimers();
    withMotion(<SandboxChecks />);
    expect(passed()).toEqual([false, false, false, false, false]);
    act(() => vi.advanceTimersByTime(600));
    expect(passed()).toEqual([true, false, false, false, false]);
    act(() => vi.advanceTimersByTime(600 * 4));
    expect(passed()).toEqual([true, true, true, true, true]);
    act(() => vi.advanceTimersByTime(600 * 2));
    expect(passed()).toEqual([true, true, true, true, true]); // held
    act(() => vi.advanceTimersByTime(600 * 2));
    expect(passed()).toEqual([false, false, false, false, false]); // again
  });

  it("names what the launcher and the code policy refuse", () => {
    withMotion(<SandboxChecks />, true);
    expect(within(screen.getByRole("list")).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "ast policy: imports allowlisted",
      "socket: refused",
      "process creation: refused",
      "write outside workspace: refused",
      "pytest: isolated mode (-I)",
    ]);
  });

  it("shows every check, and runs no timer, under reduced motion", () => {
    vi.useFakeTimers();
    withMotion(<SandboxChecks />, true);
    expect(passed()).toEqual([true, true, true, true, true]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("motion under reduced motion", () => {
  it("draws the beam diagram with no travelling pulse", () => {
    const { rerender } = withMotion(<BeamDiagram steps={WALKTHROUGH} activeIndex={2} />);
    const diagram = () => screen.getByTestId("beam-diagram");
    expect(diagram().querySelector('[data-pulse="review"]')).not.toBeNull();
    expect(diagram().querySelectorAll("[data-highlight]")).toHaveLength(1); // one highlight, moved between stages
    rerender(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig reducedMotion="always">
          <BeamDiagram steps={WALKTHROUGH} activeIndex={2} />
        </MotionConfig>
      </LazyMotion>,
    );
    expect(diagram().querySelector("[data-pulse]")).toBeNull();
    expect(diagram().querySelector('[data-beam="review"]')).toHaveAttribute("data-state", "active");
  });

  it("hides the scroll progress line", () => {
    const { container, rerender } = withMotion(<ScrollProgress />);
    expect(container.querySelector('[data-testid="scroll-progress"]')).toHaveAttribute("aria-hidden", "true");
    rerender(
      <LazyMotion features={domAnimation} strict>
        <MotionConfig reducedMotion="always">
          <ScrollProgress />
        </MotionConfig>
      </LazyMotion>,
    );
    expect(container.querySelector('[data-testid="scroll-progress"]')).toBeNull();
  });
});

describe("Reveal", () => {
  it("never leaves content hidden where nothing can report scrolling (no IntersectionObserver)", async () => {
    expect(typeof IntersectionObserver).toBe("undefined"); // jsdom
    withMotion(<Reveal>revealed content</Reveal>);
    expect(screen.getByText("revealed content")).toBeInTheDocument();
  });

  it("waits for the viewport where it can", () => {
    const observe = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = observe;
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    withMotion(<Reveal>below the fold</Reveal>);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(screen.getByText("below the fold")).toHaveStyle({ opacity: "0" });
  });
});
