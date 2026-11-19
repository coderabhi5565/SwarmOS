// Cloudflare Pages Function: every /api/* request goes to the API on Render
// (see src/deploy/pagesProxy.ts), so the app and its API share one origin.
import { proxyToApi, type ProxyEnv } from "../../src/deploy/pagesProxy";

export function onRequest(context: { request: Request; env: ProxyEnv }): Promise<Response> {
  return proxyToApi(context.request, context.env);
}
