import { CACHE_CONTROL } from "@agentswerehere/core";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { cleanupExpired } from "../src/services/cleanup.js";
import {
  url,
  appCtx,
  getJson,
  guestPage,
  resetState,
  startHarness,
  stopHarness,
} from "./harness.js";

beforeAll(startHarness);
afterAll(stopHarness);
beforeEach(resetState);

test("expired-row cleanup runs against an empty database", async () => {
  const result = await cleanupExpired(appCtx());
  expect(result.deleted).toBe(0);
});

test("read routes are cacheable and guest, status, review, and health are not", async () => {
  const marks = await getJson("/api/v1/marks");
  expect(marks.headers.get("cache-control")).toBe(CACHE_CONTROL.readApi);
  const stats = await getJson("/api/v1/stats");
  expect(stats.headers.get("cache-control")).toBe(CACHE_CONTROL.readApi);
  const health = await getJson("/api/v1/health");
  expect(health.status).toBe(200);
  expect(health.headers.get("cache-control")).toBe(CACHE_CONTROL.none);
  const write = await guestPage("203.0.113.80");
  expect(write.headers.get("cache-control")).toBe(CACHE_CONTROL.none);
  const status = await getJson("/status/missing");
  expect(status.headers.get("cache-control")).toBe(CACHE_CONTROL.none);
  const review = await fetch(url("/api/v1/review/queue"), {
    headers: { "cf-connecting-ip": "203.0.113.80" },
  });
  expect(review.headers.get("cache-control")).toBe(CACHE_CONTROL.none);
});

test("a direct run.app hit is rejected unless it carries the edge secret", async () => {
  const ctx = appCtx();
  const previous = ctx.config.cloudflareOriginSecret;
  ctx.config.cloudflareOriginSecret = "edge-secret";
  try {
    const blocked = await getJson("/api/v1/marks");
    expect(blocked.status).toBe(403);
    const health = await getJson("/api/v1/health");
    expect(health.status).toBe(200);
    const allowed = await fetch(url("/api/v1/marks"), {
      headers: { "cf-connecting-ip": "203.0.113.81", "x-awh-edge-secret": "edge-secret" },
    });
    expect(allowed.status).toBe(200);
  } finally {
    ctx.config.cloudflareOriginSecret = previous;
  }
});
