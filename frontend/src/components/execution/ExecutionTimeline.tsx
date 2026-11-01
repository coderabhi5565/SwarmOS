import { useEffect, useRef, useState } from "react";
import type { NormalizedEvent } from "@/domain/execution";
import { cn } from "@/lib/utils";
import { describeEvent, type EventCategory } from "./describeEvent";
import { formatClock } from "./format";
import { RoleDot, Section, ToneBadge } from "./primitives";

const FILTERS: { id: "all" | EventCategory; label: string }[] = [
  { id: "all", label: "All" },
  { id: "agents", label: "Agents" },
  { id: "orchestration", label: "Orchestration" },
  { id: "problems", label: "Problems" },
];

/**
 * The run's trace, newest last. With `follow`, the list keeps the newest
 * event in view as a live run grows.
 */
export function ExecutionTimeline({
  events,
  live = false,
  follow = false,
  maxHeight = "32rem",
}: {
  events: NormalizedEvent[];
  live?: boolean;
  follow?: boolean;
  maxHeight?: string;
}) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const listRef = useRef<HTMLOListElement>(null);
  const shown = events
    .map((event) => ({ event, view: describeEvent(event) }))
    .filter(({ view }) => filter === "all" || view.category === filter);

  useEffect(() => {
    const list = listRef.current;
    if (follow && list) list.scrollTop = list.scrollHeight;
  }, [follow, shown.length]);

  return (
    <Section
      id="timeline"
      title="Execution trace"
      description={`${events.length} event${events.length === 1 ? "" : "s"}, in sequence order.`}
      action={
        <div role="group" aria-label="Filter events" className="flex flex-wrap gap-1">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={filter === option.id}
              onClick={() => setFilter(option.id)}
              className={cn(
                "rounded-md px-2 py-1 text-xs transition-colors",
                filter === option.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
    >
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">No events{filter === "all" ? " yet" : " in this category"}.</p>
      ) : (
        <ol
          ref={listRef}
          role={live ? "log" : undefined}
          aria-live={live ? "polite" : undefined}
          className="space-y-1 overflow-y-auto pr-1"
          style={{ maxHeight }}
        >
          {shown.map(({ event, view }) => (
            <li key={event.seq} className="grid grid-cols-[3rem_1fr] gap-2 rounded-md px-1 py-1.5 hover:bg-accent/30">
              <span className="pt-0.5 text-right font-mono text-[11px] text-muted-foreground">#{event.seq}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {view.actor === "orchestrator" ? (
                    <span aria-hidden="true" className="inline-block size-2 shrink-0 rotate-45 bg-muted-foreground/60" />
                  ) : view.actor ? (
                    <RoleDot role={view.actor} />
                  ) : null}
                  <span className="text-sm">{view.title}</span>
                  {view.tone !== "muted" && view.tone !== "completed" && (
                    <ToneBadge tone={view.tone} pulse={false} className="py-0">
                      {view.tone === "live" ? "started" : view.tone === "findings" ? "attention" : view.tone}
                    </ToneBadge>
                  )}
                </div>
                <p className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[11px] text-muted-foreground">
                  <span>{formatClock(event.at)}</span>
                  {view.detail && <span className="min-w-0 wrap-break-word">{view.detail}</span>}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
