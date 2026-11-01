/**
 * The pre-redesign dashboard's client, kept for its hand-written types until
 * those screens are ported. Requests go through the typed client's fetch, so
 * both honour VITE_API_BASE_URL and raise ApiError (an Error subclass).
 */
import { apiFetch } from "@/api/client";
import type {
  AppConfig,
  CreateRunInput,
  ProviderModelsResult,
  RunDetail,
  RunRecord,
} from "./types";

const request = <T,>(path: string, init?: RequestInit): Promise<T> => apiFetch<T>(path, init);

export const api = {
  config: () => request<AppConfig>("/api/config"),

  listRuns: (limit = 25) =>
    request<{ runs: RunRecord[] }>(`/api/runs?limit=${limit}`).then((r) => r.runs),

  getRun: (runId: string) => request<RunDetail>(`/api/runs/${runId}`),

  createRun: (input: CreateRunInput) =>
    request<RunDetail>("/api/runs", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  providerModels: () => request<ProviderModelsResult>("/api/provider/models"),

  cancelRun: (runId: string) =>
    request<{ run_id: string; status: string }>(
      `/api/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST" },
    ),
};