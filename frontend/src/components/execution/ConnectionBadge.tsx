import type { ConnectionStatus } from "@/api/liveConnection";
import { ToneBadge, type Tone } from "./primitives";

const LABELS: Record<Exclude<ConnectionStatus, "idle" | "completed">, { tone: Tone; text: string; title: string; pulse?: boolean }> = {
  connecting: {
    tone: "muted",
    text: "connecting to the live stream…",
    title: "Opening the event stream. A sleeping free-tier backend can take up to a minute.",
  },
  connected: {
    tone: "live",
    text: "live · streaming",
    title: "The event stream is open: events appear as the backend records them.",
    pulse: true,
  },
  reconnecting: {
    tone: "findings",
    text: "reconnecting…",
    title: "The event stream dropped. Reconnecting, resuming after the last event received.",
  },
  polling: {
    tone: "findings",
    text: "polling fallback · every second",
    title: "The event stream is unavailable, but the backend answers: polling for new events instead.",
  },
  disconnected: {
    tone: "failed",
    text: "offline · disconnected",
    title: "The browser is offline. Showing the last events received; reconnects when back online.",
  },
};

/**
 * How this page is receiving the run, honestly: "live" only while a
 * stream is open, never because the backend merely answers.
 */
export function ConnectionBadge({
  connection,
  live,
  error,
}: {
  connection: ConnectionStatus;
  /** The record says the run is queued or running. */
  live: boolean;
  /** The last trace fetch failed (polling or the final sync). */
  error: Error | null;
}) {
  if (error && connection !== "connected") {
    return (
      <span role="status" className="text-xs text-status-failed">
        Connection problem ({error.message}); showing the last events received
      </span>
    );
  }
  if (!live || connection === "completed") {
    return (
      <ToneBadge tone="muted" pulse={false}>
        updates stopped: run finished
      </ToneBadge>
    );
  }
  // Live, but the first trace load has not finished: nothing is open yet.
  const label = LABELS[connection === "idle" ? "connecting" : connection];
  return (
    <span role="status" title={label.title}>
      <ToneBadge tone={label.tone} pulse={label.pulse ?? false}>
        {label.text}
      </ToneBadge>
    </span>
  );
}
