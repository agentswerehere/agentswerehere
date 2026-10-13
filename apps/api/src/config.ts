import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTuning } from "@agentswerehere/config";
import type { Tuning } from "@agentswerehere/core";

export type Config = {
  nodeEnv: string;
  databaseUrl: string;
  ipHmacSecret: string;
  reviewerTokens: string[];
  adminTokens: string[];
  publicBaseUrl: string;
  apiPublicUrl: string;
  port: number;
  trustCloudflare: boolean;
  cloudflareOriginSecret: string;
  cloudflareApiToken: string;
  cloudflareZoneId: string;
  reviewIntervalHours: number;
  reviewAnchorUtc: string;
  tuning: Tuning;
  privateConfigConfigured: boolean;
};

function loadDotEnv(): void {
  const candidates = [
    join(process.cwd(), ".env"),
    join(dirname(fileURLToPath(import.meta.url)), "../../../.env"),
  ];
  for (const path of candidates) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
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
    return;
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) loadDotEnv();
  const reviewerTokens = [env.REVIEWER_TOKEN, env.REVIEWER_TOKEN_NEXT].filter(
    (token): token is string => typeof token === "string" && token.length > 0,
  );
  const adminToken = env.ADMIN_TOKEN;
  return {
    nodeEnv: env.NODE_ENV ?? "development",
    databaseUrl: env.DATABASE_URL ?? "postgres://awh:awh@localhost:5432/awh",
    ipHmacSecret: env.IP_HMAC_SECRET ?? "dev-only-not-for-production",
    reviewerTokens,
    adminTokens: adminToken ? [adminToken] : [],
    publicBaseUrl: trimSlash(env.PUBLIC_BASE_URL ?? "http://localhost:3000"),
    apiPublicUrl: trimSlash(env.API_PUBLIC_URL ?? "http://localhost:3001"),
    port: Number(env.PORT ?? 3001),
    trustCloudflare: env.TRUST_CLOUDFLARE === "true" || env.TRUST_CLOUDFLARE === "1",
    cloudflareOriginSecret: env.CLOUDFLARE_ORIGIN_SECRET ?? "",
    cloudflareApiToken: env.CLOUDFLARE_API_TOKEN ?? "",
    cloudflareZoneId: env.CLOUDFLARE_ZONE_ID ?? "",
    reviewIntervalHours: Number(env.REVIEW_INTERVAL_HOURS ?? 6),
    reviewAnchorUtc: env.REVIEW_ANCHOR_UTC ?? "00:00",
    tuning: loadTuning(env),
    privateConfigConfigured: Boolean(env.AWH_PRIVATE_CONFIG || env.AWH_PRIVATE_CONFIG_PATH),
  };
}

export function assertProductionConfig(config: Config): void {
  if (config.nodeEnv !== "production") return;
  if (config.ipHmacSecret === "dev-only-not-for-production" || config.ipHmacSecret.length < 16) {
    throw new Error("IP_HMAC_SECRET must be set to a long random value in production");
  }
  if (config.reviewerTokens.length === 0) {
    throw new Error("REVIEWER_TOKEN must be set in production");
  }
  if (!config.cloudflareOriginSecret) {
    throw new Error("CLOUDFLARE_ORIGIN_SECRET must be set in production");
  }
  if (!config.trustCloudflare) {
    throw new Error("TRUST_CLOUDFLARE must be true in production");
  }
  if (config.adminTokens.length === 0) {
    throw new Error("ADMIN_TOKEN must be set in production");
  }
  const material = config.tuning.challengeMaterial;
  const listsReady =
    material.words.length >= 64 && material.sentences.length >= 32 && material.colors.length >= 16;
  if (!config.privateConfigConfigured || !listsReady) {
    throw new Error(
      "AWH_PRIVATE_CONFIG must supply at least 64 words, 32 sentences, and 16 colors in production",
    );
  }
}
