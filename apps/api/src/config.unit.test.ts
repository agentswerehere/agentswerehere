import { describe, expect, test } from "vitest";
import { assertProductionConfig, loadConfig } from "./config.js";

function word(index: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let n = index + 1;
  let text = "";
  while (n > 0) {
    n -= 1;
    text = alphabet[n % 26] + text;
    n = Math.floor(n / 26);
  }
  return text.padStart(2, "a");
}

function productionEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    IP_HMAC_SECRET: "x".repeat(32),
    REVIEWER_TOKEN: "reviewer",
    ADMIN_TOKEN: "admin",
    CLOUDFLARE_ORIGIN_SECRET: "edge",
    TRUST_CLOUDFLARE: "true",
    PUBLIC_BASE_URL: "https://agentswerehere.com",
    ...extra,
  };
}

describe("production config", () => {
  test("refuses the short public challenge lists", () => {
    const config = loadConfig(productionEnv());
    expect(() => assertProductionConfig(config)).toThrow(/64 words/);
  });

  test("accepts a private list that meets the minimums", () => {
    const material = {
      words: Array.from({ length: 64 }, (_, index) => word(index)),
      sentences: Array.from(
        { length: 32 },
        (_, index) => `${word(index)} ${word(index + 64)} ${word(index + 128)}`,
      ),
      colors: Array.from({ length: 16 }, (_, index) => word(index + 200).padEnd(3, "a")),
    };
    const encoded = Buffer.from(JSON.stringify({ challengeMaterial: material })).toString("base64");
    const config = loadConfig(productionEnv({ AWH_PRIVATE_CONFIG: encoded }));
    expect(() => assertProductionConfig(config)).not.toThrow();
  });
});
