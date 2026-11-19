import { describe, expect, it, vi } from "vitest";
import { apiOrigin, proxyToApi, upstreamRequest } from "./pagesProxy";

// Addresses come from the test page's own origin (jsdom's location), as the
// https form the proxy requires; no external host is named.
const PAGE = location.origin;
const API = PAGE.replace(/^http:/, "https:");

describe("apiOrigin", () => {
  it("accepts a bare https origin, without a trailing slash", () => {
    expect(apiOrigin({ SWARMOS_API_ORIGIN: `${API}/` })).toBe(API);
  });

  it("refuses anything that is not a bare https origin", () => {
    expect(apiOrigin({})).toBeNull();
    expect(apiOrigin({ SWARMOS_API_ORIGIN: PAGE })).toBeNull(); // plain http
    expect(apiOrigin({ SWARMOS_API_ORIGIN: `${API}/api` })).toBeNull(); // a path
    expect(apiOrigin({ SWARMOS_API_ORIGIN: `${API}?x=1` })).toBeNull();
  });
});

describe("upstreamRequest", () => {
  it("keeps the method, path, query, cookie and body, and names the client from Cloudflare", async () => {
    const incoming = new Request(`${PAGE}/api/runs?limit=5`, {
      method: "POST",
      headers: {
        Cookie: "swarmos_session=opaque",
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.7", // chosen by the client: not trusted
        "CF-Connecting-IP": "203.0.113.9",
      },
      body: JSON.stringify({ goal: "catalog run" }),
    });
    const upstream = upstreamRequest(incoming, API);
    expect(upstream.url).toBe(`${API}/api/runs?limit=5`);
    expect(upstream.method).toBe("POST");
    expect(upstream.headers.get("cookie")).toBe("swarmos_session=opaque");
    expect(upstream.headers.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(upstream.redirect).toBe("manual");
    expect(await upstream.json()).toEqual({ goal: "catalog run" });
  });

  it("drops a client's X-Forwarded-For when Cloudflare names no client", () => {
    const upstream = upstreamRequest(new Request(`${PAGE}/health`, { headers: { "X-Forwarded-For": "198.51.100.7" } }), API);
    expect(upstream.url).toBe(`${API}/health`);
    expect(upstream.headers.get("x-forwarded-for")).toBeNull();
  });
});

describe("proxyToApi", () => {
  it("answers 502 without calling out when no API is configured", async () => {
    const send = vi.fn<typeof fetch>();
    const response = await proxyToApi(new Request(`${PAGE}/api/config`), {}, send);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ detail: "the API origin (SWARMOS_API_ORIGIN) is not configured" });
    expect(send).not.toHaveBeenCalled();
  });

  it("passes the API's response through, Set-Cookie included", async () => {
    const answer = new Response(JSON.stringify({ authenticated: true }), {
      status: 200,
      headers: { "Set-Cookie": "swarmos_session=opaque; HttpOnly; Path=/; SameSite=lax; Secure" },
    });
    const send = vi.fn<typeof fetch>(async () => answer);
    const response = await proxyToApi(new Request(`${PAGE}/api/auth/login`, { method: "POST", body: "{}" }), { SWARMOS_API_ORIGIN: API }, send);
    expect(response).toBe(answer);
    expect((send.mock.calls[0][0] as Request).url).toBe(`${API}/api/auth/login`);
  });
});
