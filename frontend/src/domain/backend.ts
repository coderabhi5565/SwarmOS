import type { Health } from "@/api/types";

const PROVIDER_LABEL: Record<string, string> = {
  demo: "demo fixture",
  local: "local model",
  remote: "hosted model",
  unknown: "no model",
};

/**
 * Human labels for what the backend will actually run with.
 *
 * /health's provider_kind describes the configured endpoint; when the server
 * forces provider_mode "demo", runs use the deterministic fixture whatever is
 * configured, so that wins.
 */
export function describeBackend(health: Health): { mode: string; provider: string } {
  const kind = health.provider_mode === "demo" ? "demo" : health.provider_kind;
  return {
    mode: health.mode === "public_demo" ? "public demo" : "local",
    provider: PROVIDER_LABEL[kind] ?? kind,
  };
}
