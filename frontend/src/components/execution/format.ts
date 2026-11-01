/** Presentation formatting. A null value renders as "unknown", never as zero. */

export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds % 60)} s`;
}

export function formatTokens(count: number | null | undefined): string | null {
  return count === null || count === undefined ? null : count.toLocaleString("en-US");
}

export function formatUsd(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}

/** Clock time of an ISO timestamp, in UTC so traces read the same everywhere. */
export function formatClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : `${date.toISOString().slice(11, 19)} UTC`;
}

export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function humanize(value: string): string {
  return value.replace(/_/g, " ");
}
