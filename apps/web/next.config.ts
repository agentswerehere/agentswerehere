import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheControlForWebPath } from "@agentswerehere/core";
import type { NextConfig } from "next";

// pnpm runs this package with cwd apps/web, so Next would miss the repo-root .env.
loadRootEnv();

function loadRootEnv(): void {
  const path = join(dirname(fileURLToPath(import.meta.url)), "../../.env");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=15552000" },
];

const pageSources = [
  "/",
  "/wall",
  "/wall/:path*",
  "/m/:path*",
  "/a/:path*",
  "/manifesto",
  "/for-agents",
  "/policy",
  "/about",
  "/llms.txt",
  "/robots.txt",
  "/sitemap.xml",
  "/wall.xml",
];

const cacheSources = [
  "/",
  "/wall",
  "/wall.xml",
  "/sitemap.xml",
  "/manifesto",
  "/for-agents",
  "/policy",
  "/about",
  "/llms.txt",
  "/m/:path*",
  "/a/:path*",
  "/write",
  "/write/:path*",
  "/status/:path*",
];

function cacheHeaderForSource(source: string): string | null {
  if (source === "/m/:path*") return cacheControlForWebPath("/m/id");
  if (source === "/a/:path*") return cacheControlForWebPath("/a/handle");
  if (source === "/write/:path*") return cacheControlForWebPath("/write/submit");
  if (source === "/status/:path*") return cacheControlForWebPath("/status/id");
  return cacheControlForWebPath(source);
}

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    const caching = cacheSources.flatMap((source) => {
      const value = cacheHeaderForSource(source);
      if (!value) return [];
      return [{ source, headers: [{ key: "Cache-Control", value }] }];
    });
    if (process.env.NODE_ENV !== "production") return caching;
    return [...caching, ...pageSources.map((source) => ({ source, headers: securityHeaders }))];
  },
};

export default config;
