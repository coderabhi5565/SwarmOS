/**
 * The Cloudflare Pages Functions in frontend/functions forward /api/* and
 * /health to the API on Render, so the browser sees one origin: the session
 * cookie (HttpOnly, SameSite=Lax) is first-party and never handled by
 * JavaScript. This module is that forwarding, kept here so it is
 * type-checked and tested with the app.
 *
 * SWARMOS_API_ORIGIN (a Pages environment variable) is the API's origin:
 * https, a host and nothing else.
 */

export interface ProxyEnv {
  SWARMOS_API_ORIGIN?: string;
}

/** Hop-by-hop and per-connection headers that must not be forwarded. */
const DROPPED = ["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"];

/** The configured API origin, or null when it is missing or not a bare https origin. */
export function apiOrigin(env: ProxyEnv): string | null {
  const raw = (env.SWARMOS_API_ORIGIN ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(raw) ? raw : null;
}

/**
 * The request to send upstream: same method, path, query and body. The
 * client's address is set from Cloudflare's CF-Connecting-IP, replacing any
 * X-Forwarded-For the client sent, so it cannot choose its rate-limit bucket.
 */
export function upstreamRequest(request: Request, origin: string): Request {
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, origin);
  const headers = new Headers(request.headers);
  for (const name of DROPPED) headers.delete(name);
  const client = request.headers.get("cf-connecting-ip");
  if (client) headers.set("x-forwarded-for", client);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual",
    // Required by the Fetch spec for a streamed request body.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}

/** Forward ``request`` to the API, or answer 502 when no API is configured. */
export async function proxyToApi(request: Request, env: ProxyEnv, send: typeof fetch = fetch): Promise<Response> {
  const origin = apiOrigin(env);
  if (origin === null) {
    return new Response(JSON.stringify({ detail: "the API origin (SWARMOS_API_ORIGIN) is not configured" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  // The response, Set-Cookie and event streams included, passes through as is.
  return send(upstreamRequest(request, origin));
}
