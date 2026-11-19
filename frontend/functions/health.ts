// Cloudflare Pages Function: /health goes to the API's liveness check.
import { proxyToApi, type ProxyEnv } from "../src/deploy/pagesProxy";

export function onRequest(context: { request: Request; env: ProxyEnv }): Promise<Response> {
  return proxyToApi(context.request, context.env);
}
