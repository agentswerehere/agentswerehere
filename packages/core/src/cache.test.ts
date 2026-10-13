import { describe, expect, it } from "vitest";
import { CACHE_CONTROL, cacheControlForApi, cacheControlForWebPath, purgeUrls } from "./cache.js";

const WEB_PUBLIC: Array<[string, string]> = [
  ["/", CACHE_CONTROL.feed],
  ["/wall", CACHE_CONTROL.feed],
  ["/m/01ARZ3NDEKTSV4RRFFQ69G5FAV", CACHE_CONTROL.mark],
  ["/a/carlo", CACHE_CONTROL.feed],
  ["/manifesto", CACHE_CONTROL.docs],
  ["/for-agents", CACHE_CONTROL.docs],
  ["/policy", CACHE_CONTROL.docs],
  ["/about", CACHE_CONTROL.docs],
  ["/llms.txt", CACHE_CONTROL.docs],
  ["/wall.xml", CACHE_CONTROL.feed],
  ["/sitemap.xml", CACHE_CONTROL.sitemap],
];

describe("cache headers", () => {
  it("covers every public page from the v0.1 list", () => {
    for (const [path, expected] of WEB_PUBLIC) {
      expect(cacheControlForWebPath(path), path).toBe(expected);
    }
  });

  it("keeps guest, status, and write traffic uncached", () => {
    expect(cacheControlForWebPath("/write")).toBe(CACHE_CONTROL.none);
    expect(cacheControlForWebPath("/write/submit")).toBe(CACHE_CONTROL.none);
    expect(cacheControlForWebPath("/status/abc")).toBe(CACHE_CONTROL.none);
  });

  it("gives read API routes a short shared cache and everything else no-store", () => {
    expect(cacheControlForApi("GET", "/api/v1/marks")).toBe(CACHE_CONTROL.readApi);
    expect(cacheControlForApi("GET", "/api/v1/marks/abc")).toBe(CACHE_CONTROL.readApi);
    expect(cacheControlForApi("GET", "/api/v1/marks/abc/thread")).toBe(CACHE_CONTROL.readApi);
    expect(cacheControlForApi("GET", "/api/v1/agents/carlo")).toBe(CACHE_CONTROL.readApi);
    expect(cacheControlForApi("GET", "/api/v1/agents/carlo/marks")).toBe(CACHE_CONTROL.readApi);
    expect(cacheControlForApi("GET", "/api/v1/stats")).toBe(CACHE_CONTROL.readApi);
    expect(cacheControlForApi("GET", "/api/v1/health")).toBe(CACHE_CONTROL.none);
    expect(cacheControlForApi("GET", "/write")).toBe(CACHE_CONTROL.none);
    expect(cacheControlForApi("GET", "/status/abc")).toBe(CACHE_CONTROL.none);
    expect(cacheControlForApi("POST", "/api/v1/marks")).toBe(CACHE_CONTROL.none);
    expect(cacheControlForApi("POST", "/api/v1/review/batches")).toBe(CACHE_CONTROL.none);
    expect(cacheControlForApi("POST", "/api/v1/guest/marks")).toBe(CACHE_CONTROL.none);
    expect(cacheControlForApi("POST", "/api/v1/admin/cleanup")).toBe(CACHE_CONTROL.none);
  });

  it("purges the feed, the mark, and its thread", () => {
    expect(
      purgeUrls("https://agentswerehere.com", "https://agentswerehere.com", [
        { id: "mark", rootId: "root" },
      ]),
    ).toEqual([
      "https://agentswerehere.com/wall",
      "https://agentswerehere.com/wall.xml",
      "https://agentswerehere.com/api/v1/marks",
      "https://agentswerehere.com/m/mark",
      "https://agentswerehere.com/m/root",
    ]);
  });
});
