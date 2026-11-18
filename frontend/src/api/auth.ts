/**
 * Accounts: who is signed in, and signing in, up and out. The session is an
 * HttpOnly cookie the server sets; this code never sees the token. Requests
 * carry it via `credentials: "include"` (src/api/client.ts).
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { benchmarkKeys } from "./benchmarkQueries";
import { api } from "./client";
import { queryKeys } from "./queries";
import type { AuthResponse, AuthUser, LoginRequest, Me, RegisterRequest } from "./types";

export const authKeys = {
  all: ["auth"] as const,
  me: ["auth", "me"] as const,
};

/**
 * The signed-in account, or null. An unreachable or older server (no
 * /api/auth routes) reads as signed out rather than as an error.
 */
export function useMe() {
  const query = useQuery({ queryKey: authKeys.me, queryFn: api.me, staleTime: 60_000 });
  const user: AuthUser | null = query.data?.authenticated ? query.data.user : null;
  return { ...query, user, signedIn: user !== null };
}

/**
 * After signing in, up or out, everything that depends on who is asking is
 * stale: the account itself, the config, and benchmark permissions.
 */
async function refreshIdentity(client: QueryClient, response: AuthResponse) {
  client.setQueryData<Me>(authKeys.me, (previous) => ({ ...response, mode: previous?.mode ?? "" }));
  await Promise.all([
    client.invalidateQueries({ queryKey: authKeys.all }),
    client.invalidateQueries({ queryKey: queryKeys.config }),
    client.invalidateQueries({ queryKey: benchmarkKeys.suites }),
  ]);
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => api.login(body),
    onSuccess: (response) => refreshIdentity(client, response),
  });
}

export function useRegister() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: RegisterRequest) => api.register(body),
    onSuccess: (response) => refreshIdentity(client, response),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    onSuccess: (response) => refreshIdentity(client, response),
  });
}

/**
 * Where to go after signing in: a path inside this app from `?next=`, or
 * `fallback`. Anything else (another origin, `//host`, a scheme) is ignored.
 */
export function safeNext(next: string | null, fallback = "/runs/new"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  return next;
}

// ----------------------------------------------------------------------
// client-side checks, mirroring the server's (app/auth.py); the server
// remains the authority and its message is shown when it disagrees.
// ----------------------------------------------------------------------
export const MIN_PASSWORD = 8;

export function emailProblem(email: string): string | null {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) ? null : "Enter a valid email address.";
}

export function phoneProblem(phone: string): string | null {
  const digits = phone.trim().replace(/[\s\-().]/g, "");
  return /^\+?\d{10,15}$/.test(digits) ? null : "Enter 10 to 15 digits, optionally starting with +.";
}

export function passwordProblem(password: string): string | null {
  return password.length >= MIN_PASSWORD ? null : `Use at least ${MIN_PASSWORD} characters.`;
}

export function nameProblem(name: string): string | null {
  return name.trim() ? null : "Enter your name.";
}
