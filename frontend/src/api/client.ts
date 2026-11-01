/**
 * Typed HTTP client for the SwarmOS API. Every function maps to a route in
 * the backend contract (src/api/schema.d.ts); there are no mock responses.
 */
import type {
  AppConfig,
  DemoTasks,
  Health,
  RunDetail,
  RunEvents,
  RunList,
  RunRequest,
} from "./types";

/** API origin; empty means same-origin (dev proxy or FastAPI-served build). */
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

export class ApiError extends Error {
  readonly status: number;
  /** FastAPI's `detail`: a message, or validation errors for a 422. */
  readonly detail: unknown;
  /** Seconds to wait, from Retry-After on 429 responses. */
  readonly retryAfter: number | null;

  constructor(status: number, message: string, detail: unknown, retryAfter: number | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
}

type Query = Record<string, string | number | undefined | null>;

export function apiUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const search = params.toString();
  return `${API_BASE_URL}${path}${search ? `?${search}` : ""}`;
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  const { query, headers, ...rest } = init ?? {};
  const response = await fetch(apiUrl(path, query), {
    ...rest,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as T;
}

export async function toApiError(response: Response): Promise<ApiError> {
  let detail: unknown = null;
  try {
    detail = ((await response.json()) as { detail?: unknown }).detail ?? null;
  } catch {
    // not a JSON body; keep the status line
  }
  const message =
    typeof detail === "string"
      ? detail
      : Array.isArray(detail)
        ? detail.map(describeValidationError).join("; ")
        : `${response.status} ${response.statusText}`.trim();
  const retry = Number(response.headers.get("Retry-After"));
  return new ApiError(
    response.status,
    message,
    detail,
    Number.isFinite(retry) && retry > 0 ? retry : null,
  );
}

function describeValidationError(item: unknown): string {
  if (item && typeof item === "object" && "msg" in item) {
    const { loc, msg } = item as { loc?: unknown[]; msg: string };
    const where = Array.isArray(loc) ? loc.filter((part) => part !== "body").join(".") : "";
    return where ? `${where}: ${msg}` : msg;
  }
  return String(item);
}

const runPath = (runId: string) => `/api/runs/${encodeURIComponent(runId)}`;

export const api = {
  health: () => apiFetch<Health>("/health"),
  config: () => apiFetch<AppConfig>("/api/config"),
  demoTasks: () => apiFetch<DemoTasks>("/api/demo-tasks"),

  listRuns: (params: { limit?: number; cursor?: string | null } = {}) =>
    apiFetch<RunList>("/api/runs", { query: { limit: params.limit, cursor: params.cursor } }),

  getRun: (runId: string) => apiFetch<RunDetail>(runPath(runId)),

  /** Events after `afterSeq` (all of them when omitted), in seq order. */
  runEvents: (runId: string, afterSeq?: number) =>
    apiFetch<RunEvents>(`${runPath(runId)}/events`, { query: { after_seq: afterSeq } }),

  createRun: (body: RunRequest) =>
    apiFetch<RunDetail>("/api/runs", { method: "POST", body: JSON.stringify(body) }),

  cancelRun: (runId: string) =>
    apiFetch<{ run_id: string; status: "cancelling" }>(`${runPath(runId)}/cancel`, {
      method: "POST",
    }),
};
