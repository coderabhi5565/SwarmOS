import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@/api/types";
import { allFixtures, fixtures } from "./fixtures";
import type { Phase } from "./model";
import { initialState, reduce } from "./reducer";
import { createReplay, orderedEvents, replay } from "./replay";

const fixture = fixtures.demoPipelineCompleted;
const fold = (events: TraceEvent[]) => events.reduce(reduce, initialState(fixture.run));

describe("replay to a selected sequence", () => {
  it("equals folding the events up to that seq", () => {
    for (const seq of [1, 4, 9, fixture.events.length]) {
      expect(replay(fixture.events, { seed: fixture.run, untilSeq: seq })).toEqual(
        fold(fixture.events.filter((event) => event.seq <= seq)),
      );
    }
  });

  it("shows each moment as it was, not as the run ended", () => {
    const started = fixture.events.find((e) => e.kind === "verification_started")!;
    const mid = replay(fixture.events, { seed: fixture.run, untilSeq: started.seq });
    expect(mid.verifier.status).toBe("running");
    expect(mid.outcome).toBeNull();
    expect(mid.status).toBe("running"); // the record says "completed"; not yet

    const end = replay(fixture.events, { seed: fixture.run });
    expect(end.verifier.status).toBe("passed");
    expect(end.outcome?.status).toBe("completed");
  });

  it("deduplicates and orders its input", () => {
    const messy = [...fixture.events].reverse().flatMap((event) => [event, event]);
    expect(orderedEvents(messy).map((e) => e.seq)).toEqual(fixture.events.map((e) => e.seq));
    expect(replay(messy, { seed: fixture.run })).toEqual(replay(fixture.events, { seed: fixture.run }));
  });

  it("settles a never-finished trace from the record only when asked, and only for a full replay", () => {
    const events = fixture.events.filter((e) => e.kind !== "run_finished");
    expect(replay(events, { seed: fixture.run }).outcome).toBeNull();
    expect(replay(events, { seed: fixture.run, settle: true }).outcome).toMatchObject({ status: "completed", source: "record" });
    expect(replay(events, { seed: fixture.run, settle: true, untilSeq: 5 }).outcome).toBeNull();
  });
});

describe("deterministic replay", () => {
  it("produces identical state for the same events, every time", () => {
    for (const recorded of allFixtures) {
      const once = replay(recorded.events, { seed: recorded.run });
      const twice = replay(recorded.events, { seed: recorded.run });
      expect(twice, recorded.name).toEqual(once);
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    }
  });

  it("matches a scrubbable replay at every frame, in any scrubbing order", () => {
    const scrubbed = createReplay(fixture.events, fixture.run);
    const backwards = [...scrubbed.seqs].reverse();
    for (const seq of backwards) {
      expect(scrubbed.stateAt(seq)).toEqual(replay(fixture.events, { seed: fixture.run, untilSeq: seq }));
    }
    expect(scrubbed.final()).toEqual(replay(fixture.events, { seed: fixture.run }));
  });

  it("memoises frames so a position always returns the same object", () => {
    const scrubbed = createReplay(fixture.events, fixture.run);
    const late = scrubbed.stateAtIndex(10);
    scrubbed.stateAtIndex(2);
    expect(scrubbed.stateAtIndex(10)).toBe(late);
    expect(scrubbed.stateAt(scrubbed.seqs[10])).toBe(late);
  });

  it("maps seqs before, between and after frames", () => {
    const withGap = fixture.events.filter((e) => e.seq !== 6);
    const scrubbed = createReplay(withGap, fixture.run);
    expect(scrubbed.length).toBe(withGap.length);
    expect(scrubbed.stateAt(0)).toBe(scrubbed.initial);
    expect(scrubbed.stateAt(6)).toBe(scrubbed.stateAt(5)); // inside the gap
    expect(scrubbed.stateAt(999)).toBe(scrubbed.final());
    expect(createReplay([]).final()).toEqual(initialState());
  });

  it("moves forward through the phases of a run in order", () => {
    const scrubbed = createReplay(fixture.events, fixture.run);
    const phases: Phase[] = [];
    for (let index = 0; index < scrubbed.length; index += 1) {
      const phase = scrubbed.stateAtIndex(index).phase;
      if (phases.at(-1) !== phase) phases.push(phase);
    }
    expect(phases).toEqual(["planning", "coding", "reviewing", "verifying", "finished"]);
  });
});
