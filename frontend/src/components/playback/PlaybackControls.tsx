import { Pause, Play, Radio, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { describeEvent } from "@/components/execution/describeEvent";
import { formatDuration } from "@/components/execution/format";
import { ToneBadge } from "@/components/execution/primitives";
import { Button } from "@/components/ui/button";
import { lifecycleRecorded, type ExecutionState } from "@/domain/execution";
import { PLAYBACK_SPEEDS, useViewStore } from "@/store/viewStore";
import { usePlaybackClock, type PlaybackView } from "./usePlayback";

/**
 * Replay controls for a run: play, pause, restart, step, scrub, speed. They
 * drive a position in the shared view store; every panel and both graph
 * views draw the same replay frame.
 */
export function PlaybackControls({
  execution,
  view,
  live,
}: {
  /** The run as it is now (live or finished), never a replay frame. */
  execution: ExecutionState;
  view: PlaybackView;
  live: boolean;
}) {
  const speed = useViewStore((state) => state.playbackSpeed);
  const setSpeed = useViewStore((state) => state.setPlaybackSpeed);
  const seek = useViewStore((state) => state.seek);
  const play = useViewStore((state) => state.play);
  const pause = useViewStore((state) => state.pause);
  const exit = useViewStore((state) => state.exitPlayback);

  const length = view.replay?.length ?? 0;
  const last = length - 1;
  const position = view.index ?? last;
  usePlaybackClock(length, view.index, view.playing, speed);

  if (length === 0) return null;

  const event = execution.log[position];
  const presented = event ? describeEvent(event) : null;
  const elapsed = elapsedMs(execution.log[0]?.at, event?.at);
  const atEnd = position >= last;

  return (
    <section aria-label="Playback" className="glass space-y-3 rounded-xl p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        {view.replaying ? (
          <ToneBadge tone="findings" pulse={false}>
            replay
          </ToneBadge>
        ) : live ? (
          <ToneBadge tone="live">live</ToneBadge>
        ) : (
          <ToneBadge tone="muted" pulse={false}>
            latest state
          </ToneBadge>
        )}
        <div role="group" aria-label="Playback controls" className="flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Restart" onClick={() => play(0)}>
            <RotateCcw aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Previous event" disabled={position <= 0} onClick={() => seek(position - 1)}>
            <SkipBack aria-hidden="true" />
          </Button>
          {view.playing ? (
            <Button variant="secondary" size="icon" aria-label="Pause" onClick={pause}>
              <Pause aria-hidden="true" />
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="icon"
              aria-label="Play"
              // From the start when not replaying or at the end; else resume.
              onClick={() => play(!view.replaying || atEnd ? 0 : position)}
            >
              <Play aria-hidden="true" />
            </Button>
          )}
          <Button variant="ghost" size="icon" aria-label="Next event" disabled={!view.replaying || atEnd} onClick={() => seek(position + 1)}>
            <SkipForward aria-hidden="true" />
          </Button>
        </div>
        <div role="group" aria-label="Playback speed" className="inline-flex rounded-lg border border-border p-0.5">
          {PLAYBACK_SPEEDS.map((option) => (
            <Button
              key={option}
              variant={speed === option ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 font-mono text-xs"
              aria-pressed={speed === option}
              onClick={() => setSpeed(option)}
            >
              {option}×
            </Button>
          ))}
        </div>
        {view.replaying && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={exit}>
            <Radio aria-hidden="true" />
            {live ? "Back to live" : "Show latest"}
          </Button>
        )}
      </div>

      <input
        type="range"
        min={0}
        max={last}
        step={1}
        value={position}
        aria-label="Playback position"
        aria-valuetext={`event ${position + 1} of ${length}${event ? `, seq ${event.seq}` : ""}`}
        onChange={(change) => seek(Number(change.target.value))}
        className="w-full accent-[var(--primary)]"
      />

      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
        <p aria-live="polite">
          <span className="font-mono">
            Event {position + 1} of {length}
            {event && <span className="text-muted-foreground"> · seq {event.seq}</span>}
          </span>
          {presented && (
            <span className="text-foreground/90">
              {" "}
              — {presented.title}
              {presented.detail && <span className="text-muted-foreground"> ({presented.detail})</span>}
            </span>
          )}
        </p>
        <p className="font-mono text-muted-foreground">
          {elapsed === null ? "time not recorded" : `+${formatDuration(elapsed)} after the first event (recorded)`}
        </p>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Playback steps through the recorded events one at a time; it does not reproduce how long each took.
        {!lifecycleRecorded(execution) &&
          " This trace has no start events, so playback shows results as they were recorded, never work in progress."}
      </p>
    </section>
  );
}

/** Milliseconds between two recorded timestamps; null when either is missing or unreadable. */
function elapsedMs(from: string | undefined, to: string | undefined): number | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  return Number.isNaN(start) || Number.isNaN(end) || end < start ? null : end - start;
}
