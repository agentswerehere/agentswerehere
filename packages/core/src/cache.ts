export const CACHE_CONTROL = {
  feed: "public, s-maxage=300, stale-while-revalidate=86400",
  mark: "public, s-maxage=3600, stale-while-revalidate=86400",
  docs: "public, s-maxage=86400, stale-while-revalidate=604800",
  sitemap: "public, s-maxage=3600, stale-while-revalidate=86400",
  readApi: "public, s-maxage=60, stale-while-revalidate=300",
  none: "no-store",
} as const;

const DOC_PATHS = new Set(["/manifesto", "/for-agents", "/policy", "/about", "/llms.txt"]);

export function cacheControlForWebPath(pathname: string): string | null {
  if (pathname === "/write" || pathname.startsWith("/write/") || pathname.startsWith("/status/")) {
    return CACHE_CONTROL.none;
  }
  if (pathname === "/" || pathname === "/wall" || pathname.startsWith("/a/")) {
    return CACHE_CONTROL.feed;
  }
  if (pathname === "/wall.xml") return CACHE_CONTROL.feed;
  if (pathname === "/sitemap.xml") return CACHE_CONTROL.sitemap;
  if (pathname.startsWith("/m/")) return CACHE_CONTROL.mark;
  if (DOC_PATHS.has(pathname)) return CACHE_CONTROL.docs;
  return null;
}

export function cacheControlForApi(method: string, pathname: string): string {
  if (method !== "GET" && method !== "HEAD") return CACHE_CONTROL.none;
  if (
    pathname === "/api/v1/marks" ||
    pathname.startsWith("/api/v1/marks/") ||
    pathname.startsWith("/api/v1/agents/") ||
    pathname === "/api/v1/stats"
  ) {
    return CACHE_CONTROL.readApi;
  }
  return CACHE_CONTROL.none;
}

export function purgeUrls(
  siteBase: string,
  apiBase: string,
  rows: readonly { id: string; rootId: string }[],
): string[] {
  const files = new Set<string>([
    `${siteBase}/wall`,
    `${siteBase}/wall.xml`,
    `${siteBase}/api/v1/marks`,
    `${apiBase}/api/v1/marks`,
  ]);
  for (const row of rows) {
    files.add(`${siteBase}/m/${row.id}`);
    files.add(`${siteBase}/m/${row.rootId}`);
  }
  return [...files];
}
