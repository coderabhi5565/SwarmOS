import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, type ExecutionState } from "@/domain/execution";
import { fixtures } from "@/domain/execution/fixtures";
import { useViewStore } from "@/store/viewStore";
import { ExecutionView } from "@/components/visualization/ExecutionView";
import type { ExecutionScene3DProps } from "@/components/visualization/ExecutionScene3D";
import { resetWebglCheck } from "@/components/visualization/webgl";
import { PlaybackControls } from "./PlaybackControls";
import { PLAYBACK_STEP_MS, usePlayback } from "./usePlayback";

const scene = vi.hoisted(() => ({ props: null as ExecutionScene3DProps | null }));
vi.mock("@/components/visualization/ExecutionScene3D", () => ({
  default: (props: ExecutionScene3DProps) => {
    scene.props = props;
    return <div data-testid="scene-stand-in" />;
  },
}));

type Name = keyof typeof fixtures;
const final = (name: Name) => replay(fixtures[name].events, { seed: fixtures[name].run, settle: true });

/** What Run Detail does: one playback over the run, drawn by the views. */
function Player({ execution, live = false }: { execution: ExecutionState; live?: boolean }) {
  const view = usePlayback(execution);
  return (
    <>
      <PlaybackControls execution={execution} view={view} live={live} />
      <ExecutionView state={view.displayed!} live={live && !view.replaying} replaying={view.replaying} />
      <p data-testid="shown-seq">{view.displayed!.lastSeq}</p>
    </>
  );
}

const initial = useViewStore.getState();
const control = (name: string) => within(screen.getByRole("group", { name: "Playback controls" })).getByRole("button", { name });
const slider = () => screen.getByRole("slider", { name: "Playback position" });
const shownSeq = () => Number(screen.getByTestId("shown-seq").textContent);
const graphNode = (name: RegExp) => within(screen.getByTestId("execution-graph-2d")).getByRole("group", { name });

beforeEach(() => {
  useViewStore.setState(initial, true);
  scene.props = null;
});
afterEach(() => {
  vi.useRealTimers();
  resetWebglCheck();
});

describe("PlaybackControls", () => {
  it("opens on the finished run's latest state, not a replay", () => {
    const execution = final("demoPipelineCompleted");
    render(<Player execution={execution} />);
    expect(screen.getByText("latest state")).toBeInTheDocument();
    expect(screen.getByText(`Event ${execution.log.length} of ${execution.log.length}`)).toBeInTheDocument();
    expect(shownSeq()).toBe(execution.lastSeq);
    expect(screen.queryByRole("button", { name: /Show latest/ })).not.toBeInTheDocument();
    expect(useViewStore.getState().playback).toBeNull();
  });

  it("plays from the start one event per step, and pauses at the end", async () => {
    vi.useFakeTimers();
    const execution = final("reviewInvalid");
    const total = execution.log.length;
    render(<Player execution={execution} />);

    fireEvent.click(control("Play"));
    expect(shownSeq()).toBe(execution.log[0].seq);
    expect(screen.getByText("replay")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(PLAYBACK_STEP_MS));
    expect(shownSeq()).toBe(execution.log[1].seq);
    await act(() => vi.advanceTimersByTimeAsync(PLAYBACK_STEP_MS * total));
    expect(shownSeq()).toBe(execution.log[total - 1].seq);
    expect(useViewStore.getState().playback).toEqual({ index: total - 1, playing: false });
    expect(control("Play")).toBeInTheDocument();
  });

  it("pauses, resumes, steps and restarts", async () => {
    vi.useFakeTimers();
    const execution = final("retryEscalation");
    render(<Player execution={execution} />);
    fireEvent.click(control("Play"));
    await act(() => vi.advanceTimersByTimeAsync(PLAYBACK_STEP_MS * 3));
    fireEvent.click(control("Pause"));
    const paused = shownSeq();
    await act(() => vi.advanceTimersByTimeAsync(PLAYBACK_STEP_MS * 5));
    expect(shownSeq()).toBe(paused);

    fireEvent.click(control("Next event"));
    expect(shownSeq()).toBe(execution.log[4].seq);
    fireEvent.click(control("Previous event"));
    fireEvent.click(control("Previous event"));
    expect(shownSeq()).toBe(execution.log[2].seq);

    fireEvent.click(control("Restart"));
    expect(useViewStore.getState().playback).toEqual({ index: 0, playing: true });
    expect(shownSeq()).toBe(execution.log[0].seq);
  });

  it("seeks with the slider and changes speed", async () => {
    vi.useFakeTimers();
    const execution = final("verificationRepair");
    render(<Player execution={execution} />);
    fireEvent.change(slider(), { target: { value: "9" } });
    expect(useViewStore.getState().playback).toEqual({ index: 9, playing: false });
    expect(slider()).toHaveAttribute("aria-valuetext", `event 10 of ${execution.log.length}, seq ${execution.log[9].seq}`);
    expect(screen.getByText(`Event 10 of ${execution.log.length}`)).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("group", { name: "Playback speed" })).getByRole("button", { name: "4×" }));
    fireEvent.click(control("Play"));
    await act(() => vi.advanceTimersByTimeAsync(PLAYBACK_STEP_MS / 4));
    expect(useViewStore.getState().playback?.index).toBe(10);
    await act(() => vi.advanceTimersByTimeAsync(PLAYBACK_STEP_MS / 4 - 1));
    expect(useViewStore.getState().playback?.index).toBe(10);
  });

  it("shows elapsed time only from recorded timestamps", () => {
    const execution = final("demoPipelineCompleted");
    render(<Player execution={execution} />);
    const expected = Date.parse(execution.log.at(-1)!.at) - Date.parse(execution.log[0].at);
    expect(screen.getByText(/after the first event \(recorded\)/)).toBeInTheDocument();
    expect(expected).toBeGreaterThanOrEqual(0);

    const missing: ExecutionState = { ...execution, log: execution.log.map((event) => ({ ...event, at: "" })) };
    render(<Player execution={missing} />);
    expect(screen.getByText("time not recorded")).toBeInTheDocument();
  });

  it("says what an old trace cannot replay", () => {
    render(<Player execution={final("legacyPlannerRevision")} />);
    expect(screen.getByText(/no start events, so playback shows results as they were recorded/)).toBeInTheDocument();
  });

  it("replays deterministically: a position is always the same state", () => {
    const fixture = fixtures.parallelOverlap;
    const execution = final("parallelOverlap");
    render(<Player execution={execution} />);
    fireEvent.change(slider(), { target: { value: "7" } });
    const seq = execution.log[7].seq;
    // Frame 7 is the state after the 8th event: both coders running.
    expect(graphNode(/^Coder step alpha: running/)).toBeInTheDocument();
    expect(graphNode(/^Coder step beta: running/)).toBeInTheDocument();
    expect(shownSeq()).toBe(seq);
    const reference = replay(fixture.events, { seed: execution.seed, untilSeq: seq });
    expect(reference.agents.coder.activeInvocationIds).toHaveLength(2);
  });
});

describe("live and replay", () => {
  const fixture = fixtures.parallelOverlap;
  const upTo = (seq: number) => replay(fixture.events.filter((e) => e.seq <= seq), { seed: fixture.run });

  it("keeps a replay frame while the live run moves on, and returns to the latest", () => {
    const early = upTo(10);
    const snapshot = structuredClone(early);
    const { rerender } = render(<Player execution={early} live />);
    expect(screen.getByText("live")).toBeInTheDocument();
    fireEvent.change(slider(), { target: { value: "3" } });
    expect(shownSeq()).toBe(early.log[3].seq);

    // Events keep arriving into the live state while replaying.
    const later = upTo(16);
    rerender(<Player execution={later} live />);
    expect(shownSeq()).toBe(early.log[3].seq);
    expect(screen.getByText(`Event 4 of ${later.log.length}`)).toBeInTheDocument();
    // Replaying never touched the live state.
    expect(early).toEqual(snapshot);

    fireEvent.click(screen.getByRole("button", { name: "Back to live" }));
    expect(shownSeq()).toBe(16);
    expect(useViewStore.getState().playback).toBeNull();
  });

  it("does not follow live work or call itself live while replaying", () => {
    render(<Player execution={upTo(8)} live />);
    expect(screen.getByRole("button", { name: "Following live" })).toBeInTheDocument();
    fireEvent.change(slider(), { target: { value: "2" } });
    expect(screen.queryByRole("button", { name: /Follow/ })).not.toBeInTheDocument();
    expect(screen.getByText("replay frame")).toBeInTheDocument();
  });

  it("keeps the position and selection when switching between 2D and 3D", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({}) as never);
    resetWebglCheck();
    const execution = final("parallelOverlap");
    render(<Player execution={execution} />);
    fireEvent.change(slider(), { target: { value: "7" } });
    fireEvent.click(graphNode(/^Coder step beta/));

    fireEvent.click(within(screen.getByRole("group", { name: "View" })).getByRole("button", { name: "3D scene" }));
    await screen.findByTestId("scene-stand-in");
    // The scene draws the same frame: both coders active.
    const active = scene.props!.model.nodes.filter((node) => node.active).map((node) => node.id);
    expect(active).toEqual(["step:alpha", "step:beta"]);
    expect(useViewStore.getState()).toMatchObject({ playback: { index: 7 }, selection: { kind: "step", stepId: "beta" } });

    fireEvent.click(within(screen.getByRole("group", { name: "View" })).getByRole("button", { name: "2D graph" }));
    expect(graphNode(/^Coder step beta: running/)).toBeInTheDocument();
    expect(shownSeq()).toBe(execution.log[7].seq);
  });

  it("animates replayed activity only when motion is allowed", () => {
    const execution = final("parallelOverlap");
    useViewStore.getState().seek(7);
    const { container, unmount } = render(<Player execution={execution} />);
    expect(container.querySelectorAll(".react-flow__edge.animated").length).toBeGreaterThan(0);
    unmount();

    // As the app's MotionConfig does when the OS asks for reduced motion.
    const reduced = render(
      <MotionConfig reducedMotion="always">
        <Player execution={execution} />
      </MotionConfig>,
    );
    expect(graphNode(/^Coder step alpha: running/)).toBeInTheDocument();
    expect(reduced.container.querySelector(".react-flow__edge.animated")).toBeNull();
  });
});
