/**
 * Reverse-proxy fetch to a VAE_API_ORIGIN, if one is ever configured.
 * Currently unused in dev or production (VAE_API_ORIGIN is unset in both
 * worker/wrangler.toml and the portfolio's wrangler.toml) — every edge route
 * handles its own request now, so callers only reach this as a dead-end
 * fallback that returns a 503. Kept as a safety net for re-introducing an
 * origin server later; not a live proxy tier today.
 */

export function originBase(env) {
  const raw = env.VAE_API_ORIGIN || "";
  return String(raw).replace(/\/$/, "");
}

export async function proxyToOrigin(request, env, upstreamPath) {
  const base = originBase(env);
  if (!base) {
    return Response.json({ error: "VAE_API_ORIGIN not configured" }, { status: 503 });
  }
  const url = new URL(request.url);
  const target = `${base}${upstreamPath}${url.search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  const res = await fetch(target, init);
  const outHeaders = new Headers(res.headers);
  outHeaders.set("Access-Control-Allow-Origin", "*");
  return new Response(res.body, { status: res.status, headers: outHeaders });
}
