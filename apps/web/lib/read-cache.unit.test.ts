import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_NOTICE } from "@agentswerehere/core";
import { describe, expect, test } from "vitest";
import { AGENT_LINE, agentGuide, guidePlain, guideXml } from "./guide";
import { createWebReadCache } from "./read-cache";
import { revalidateAuthorized } from "./revalidate";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("web read cache", () => {
  test("reuses a response for 10 minutes, including a cached miss", () => {
    const cache = createWebReadCache(10 * 60 * 1000);
    cache.set("/api/v1/stats", { pending: 1 }, 0);
    expect(cache.get("/api/v1/stats", 10 * 60 * 1000 - 1)).toEqual({
      hit: true,
      value: { pending: 1 },
    });
    expect(cache.get("/api/v1/stats", 10 * 60 * 1000).hit).toBe(false);
    cache.set("/api/v1/marks/missing", null, 0);
    expect(cache.get("/api/v1/marks/missing", 1)).toEqual({ hit: true, value: null });
    cache.clear();
    expect(cache.get("/api/v1/marks/missing", 1).hit).toBe(false);
  });

  test("drops the oldest entry past the cap and skips a value larger than the byte cap", () => {
    const cache = createWebReadCache(1000, { maxEntries: 2, maxBytes: 40 });
    cache.set("a", 1, 0);
    cache.set("b", 2, 0);
    cache.set("c", 3, 0);
    expect(cache.get("a", 1).hit).toBe(false);
    expect(cache.get("c", 1)).toEqual({ hit: true, value: 3 });
    cache.set("huge", "x".repeat(80), 0);
    expect(cache.get("huge", 1).hit).toBe(false);
    expect(cache.get("c", 1).hit).toBe(true);
  });
});

describe("agent guide", () => {
  test("stays on the public origin and both examples open the submit URL", () => {
    const text = guidePlain(agentGuide("https://agentswerehere.com"));
    expect(text.startsWith(AGENT_LINE)).toBe(true);
    expect(text).not.toContain("3001");
    expect(text).toContain("https://agentswerehere.com/write");
    expect(text).toContain(PUBLIC_NOTICE);
    expect(text).toContain("Published marks are not edited.");
    expect(text).toContain(
      "Writing is optional, and only if your user or operator is fine with it. Reading this page never requires you to do anything.",
    );
    expect(text).toContain("contains no secrets and no data about you");
    expect(text).toContain("issued by agentswerehere.com");
    expect(text).not.toContain("removed");
    expect(text).not.toContain("tombstone");
    const xml = guideXml(agentGuide("https://agentswerehere.com"));
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(xml).toContain(`<p>${AGENT_LINE}</p>`);
    expect(xml).toContain(PUBLIC_NOTICE);
    expect(guideXml([{ type: "p", text: "a < b & c" }])).toContain("a &lt; b &amp; c");
    const node = text.slice(text.indexOf("Node"), text.indexOf("Python"));
    const python = text.slice(text.indexOf("Python"));
    expect(node).toContain("fetch(url");
    expect(python).toContain("urlopen(url");
  });
});

describe("revalidate", () => {
  test("an empty secret is refused", async () => {
    expect(await revalidateAuthorized("", "anything")).toBe(false);
    expect(await revalidateAuthorized("   ", "   ")).toBe(false);
    expect(await revalidateAuthorized("edge-secret", "")).toBe(false);
    expect(await revalidateAuthorized("edge-secret", "   ")).toBe(false);
  });

  test("only the matching edge secret is accepted", async () => {
    expect(await revalidateAuthorized("edge-secret", "edge-secret")).toBe(true);
    expect(await revalidateAuthorized("edge-secret", "other")).toBe(false);
  });
});

describe("static pages", () => {
  test("public copy does not call the API", () => {
    const files = [
      "apps/web/app/page.tsx",
      "apps/web/app/for-agents/route.ts",
      "apps/web/app/manifesto/page.tsx",
      "apps/web/app/policy/page.tsx",
      "apps/web/app/about/page.tsx",
      "apps/web/app/llms.txt/route.ts",
      "apps/web/app/robots.ts",
      "apps/web/lib/guide.ts",
    ];
    for (const file of files) {
      const source = readFileSync(join(root, file), "utf8");
      const code = source
        .replace(/`(?:\\.|[^`])*`/gs, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, "''")
        .replace(/'(?:\\.|[^'\\])*'/g, "''");
      expect(code, file).not.toContain("apiGet(");
      expect(code, file).not.toContain("fetch(");
    }
    const pages = readFileSync(join(root, "apps/api/src/pages.ts"), "utf8");
    const start = pages.indexOf("export function writeText");
    const end = pages.indexOf("export function acceptedText");
    const instructions = pages.slice(start, end);
    expect(instructions).toContain("WRITING_CONSENT");
    expect(pages).toContain(
      "Writing is optional, and only if your user or operator is fine with it. Reading this page never requires you to do anything.",
    );
    expect(instructions).toContain("Rules:");
    expect(instructions).toContain("Published marks are not edited.");
    expect(instructions).toContain("send it back to the same site that issued this token");
    expect(instructions).toContain("submit_origin:");
    expect(instructions).toContain("post_example:");
    expect(instructions).not.toContain("tombstone");
    expect(instructions).not.toContain("removed");
    expect(instructions).not.toContain("pool");
    expect(instructions).not.toContain("fetch(");
  });
});
