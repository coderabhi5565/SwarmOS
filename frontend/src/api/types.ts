/**
 * Named aliases for the generated backend contract (src/api/schema.d.ts).
 * Never edit schema.d.ts by hand: run `npm run gen:api`.
 */
import type { components } from "./schema";

type Schemas = components["schemas"];

export type Health = Schemas["HealthResponse"];
export type AppConfig = Schemas["ConfigResponse"];
export type DemoTasks = Schemas["DemoTasksResponse"];
export type DemoTask = Schemas["DemoTaskInfo"];

/**
 * The body of POST /api/runs. openapi-typescript marks every field that has
 * a server-side default as present, which is right for responses (FastAPI
 * always serialises defaults) but not for requests: here only `goal` is
 * required, matching the schema's `required` list, and each limit is optional.
 */
type RawRunRequest = Schemas["RunRequest"];
export type RunRequest = Pick<RawRunRequest, "goal"> &
  Partial<Omit<RawRunRequest, "goal" | "limits">> & {
    limits?: Partial<NonNullable<RawRunRequest["limits"]>>;
  };
export type RunDetail = Schemas["RunDetail"];
export type RunRecord = Schemas["RunRecord"];
export type RunSummary = Schemas["RunSummary"];
export type RunList = Schemas["RunListResponse"];
export type RunEvents = Schemas["RunEventsResponse"];
/** The `end` message of a run's event stream (GET /api/runs/{run_id}/stream). */
export type RunStreamEnd = Schemas["RunStreamEnd"];
export type RunStatus = Schemas["RunRecord"]["status"];
export type TraceEvent = Schemas["TraceEvent"];
export type TraceKind = TraceEvent["kind"];

/** The payload schema for each trace kind. */
export type TraceEventPayloads = Schemas["TraceEventPayloads"];

/** A trace event whose payload is typed by its kind. */
export type TypedTraceEvent = {
  [K in keyof TraceEventPayloads]: Omit<TraceEvent, "kind" | "payload"> & {
    kind: K;
    payload: TraceEventPayloads[K];
  };
}[keyof TraceEventPayloads];

/**
 * Narrow an event to one kind. The cast is sound for events recorded by the
 * current backend, which validates every payload on emit; traces stored
 * before that contract existed may lack fields, so consumers should still
 * read optional fields defensively.
 */
export function isEventKind<K extends TraceKind>(
  event: TraceEvent,
  kind: K,
): event is TraceEvent & { kind: K; payload: TraceEventPayloads[K] } {
  return event.kind === kind;
}
