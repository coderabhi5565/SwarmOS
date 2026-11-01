import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./client";

const MAX_RETRIES = 4;

/**
 * Retry network failures and server errors (a sleeping free-tier backend
 * answers with connection errors or 5xx while it wakes), but never a 4xx:
 * a 403 from the public demo or a 404 will not change on retry, and a 429
 * already tells the client when to come back.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  if (error instanceof ApiError) return error.status >= 500;
  return true; // fetch rejected: offline, DNS, CORS, or the server is waking
}

export function retryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        retryDelay,
        staleTime: 5_000,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
