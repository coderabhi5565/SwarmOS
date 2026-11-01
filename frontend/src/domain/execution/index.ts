/**
 * The execution domain: trace events in, normalised execution state out.
 * Framework free; the 2D and 3D views and the timeline all consume this.
 */
export type * from "./model";
export { normalizeEvent, type NormalizedEvent } from "./events";
export { applyEvent, initialState, isTerminal, reduce, settleWithRecord } from "./reducer";
export { createReplay, orderedEvents, replay, type Replay, type ReplayOptions } from "./replay";
