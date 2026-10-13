export default {
  async fetch(request, env, ctx) {
    const incoming = new URL(request.url);
    const api = incoming.pathname === "/api" || incoming.pathname.startsWith("/api/");
    const origin = api ? env.API_ORIGIN : env.WEB_ORIGIN;
    const target = new URL(`${incoming.pathname}${incoming.search}`, origin);
    const headers = new Headers(request.headers);
    headers.set("X-AWH-Edge-Secret", env.ORIGIN_SECRET);
    headers.set("X-Forwarded-Host", incoming.host);
    headers.set("X-Forwarded-Proto", "https");
    const clientIp = request.headers.get("CF-Connecting-IP");
    if (clientIp) headers.set("CF-Connecting-IP", clientIp);

    const cacheable = request.method === "GET" || request.method === "HEAD";
    const cache = caches.default;
    if (cacheable) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }

    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
    const cacheControl = response.headers.get("cache-control") ?? "";
    if (cacheable && response.ok && originAllowsCache(cacheControl)) {
      ctx.waitUntil(cache.put(request, response.clone()));
    }
    return response;
  },
};

function originAllowsCache(header) {
  return /(?:^|,)\s*public\s*(?:,|$)|(?:^|,)\s*s-maxage\s*=/i.test(header);
}
