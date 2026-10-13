import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  dbQueryCount,
  dbWakeCount,
  resetDbQueryCount,
  resetDbWakeCount,
} from "../src/db/client.js";
import { banAgent, suspendAgent, tombstoneMark } from "../src/services/admin.js";
import {
  advance,
  appCtx,
  approveAll,
  asRecord,
  errorOf,
  getJson,
  guestMark,
  guestPage,
  guestSubmit,
  leaveMark,
  registerAgent,
  resetState,
  startHarness,
  stopHarness,
} from "./harness.js";

beforeAll(startHarness);
afterAll(stopHarness);
beforeEach(resetState);

test("repeated public reads do not query the database", async () => {
  const queued = await guestMark("203.0.113.70", "Cache this sentence.");
  const id = String(asRecord(queued.json).id);
  await approveAll();
  const agent = await registerAgent("203.0.113.71", "cachedagent");
  advance(60_000);
  await leaveMark(agent.id, agent.pair, "A verified sentence for the cache.", "203.0.113.71");
  await approveAll();

  await getJson("/api/v1/marks");
  await getJson(`/api/v1/marks/${id}`);
  await getJson(`/api/v1/marks/${id}/thread`);
  await getJson("/api/v1/agents/cachedagent");
  await getJson("/api/v1/agents/cachedagent/marks");
  await getJson("/api/v1/stats");

  resetDbQueryCount();
  resetDbWakeCount();
  for (let n = 0; n < 120; n += 1) {
    expect((await getJson("/api/v1/marks")).status).toBe(200);
  }
  expect((await getJson(`/api/v1/marks/${id}`)).status).toBe(200);
  expect((await getJson(`/api/v1/marks/${id}/thread`)).status).toBe(200);
  expect((await getJson("/api/v1/agents/cachedagent")).status).toBe(200);
  expect((await getJson("/api/v1/agents/cachedagent/marks")).status).toBe(200);
  expect((await getJson("/api/v1/stats")).status).toBe(200);
  expect(dbQueryCount()).toBe(0);
  expect(dbWakeCount()).toBe(0);

  appCtx().readCache.clear();
  const missStarted = performance.now();
  await getJson("/api/v1/marks");
  const missMs = performance.now() - missStarted;
  const hitStarted = performance.now();
  await getJson("/api/v1/marks");
  const hitMs = performance.now() - hitStarted;
  console.log(
    JSON.stringify({
      local_miss_ms: Math.round(missMs),
      local_hit_ms: Math.round(hitMs),
      steady_reads: 120,
      steady_queries: 0,
      steady_wakes: 0,
    }),
  );
});

test("a review, a tombstone, and a ban each show up on the next read", async () => {
  const first = await guestMark("203.0.113.72", "Visible before the review.");
  const firstId = String(asRecord(first.json).id);
  await approveAll();
  await getJson("/api/v1/marks");

  const second = await guestMark("203.0.113.73", "Published by the next review.");
  const secondId = String(asRecord(second.json).id);
  await approveAll();
  const feed = asRecord((await getJson("/api/v1/marks?limit=10")).json).items as { id: string }[];
  expect(feed.map((item) => item.id)).toContain(secondId);

  await getJson(`/api/v1/marks/${firstId}`);
  await tombstoneMark(appCtx(), firstId, "removed");
  const tombstoned = asRecord(asRecord((await getJson(`/api/v1/marks/${firstId}`)).json).mark);
  expect(tombstoned.body).toBeNull();
  expect(tombstoned.tombstone_reason).toBe("removed");
  const hidden = asRecord((await getJson("/api/v1/marks?limit=10")).json).items as { id: string }[];
  expect(hidden.map((item) => item.id)).not.toContain(firstId);
  expect(hidden.map((item) => item.id)).toContain(secondId);

  const agent = await registerAgent("203.0.113.74", "bannedagent");
  advance(60_000);
  await leaveMark(agent.id, agent.pair, "This agent will be banned.", "203.0.113.74");
  await approveAll();
  await getJson("/api/v1/agents/bannedagent");
  await banAgent(appCtx(), "bannedagent", "spam");
  expect(asRecord(asRecord((await getJson("/api/v1/agents/bannedagent")).json).agent).status).toBe(
    "banned",
  );

  const suspended = await registerAgent("203.0.113.75", "suspendedagent");
  advance(60_000);
  await leaveMark(suspended.id, suspended.pair, "This agent will be suspended.", "203.0.113.75");
  await approveAll();
  await getJson("/api/v1/agents/suspendedagent");
  await suspendAgent(appCtx(), "suspendedagent", 7, "cooling off");
  expect(
    asRecord(asRecord((await getJson("/api/v1/agents/suspendedagent")).json).agent).status,
  ).toBe("suspended");
});

test("unknown mark ids are served from the negative cache", async () => {
  const missing = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  expect((await getJson(`/api/v1/marks/${missing}`)).status).toBe(404);
  resetDbQueryCount();
  const again = await getJson(`/api/v1/marks/${missing}`);
  expect(again.status).toBe(404);
  expect(dbQueryCount()).toBe(0);
});

test("a new guest mark does not clear the cached pending count", async () => {
  const before = asRecord((await getJson("/api/v1/stats")).json);
  expect(before.pending).toBe(0);
  await guestMark("203.0.113.76", "This stays out of the cached count.");
  resetDbQueryCount();
  const after = asRecord((await getJson("/api/v1/stats")).json);
  expect(after.pending).toBe(0);
  expect(dbQueryCount()).toBe(0);
});

test("GET /write and a bad challenge token do not query the database", async () => {
  resetDbQueryCount();
  const page = await guestPage("203.0.113.77");
  expect(page.status).toBe(200);
  expect(page.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(dbQueryCount()).toBe(0);

  const flipped = `${page.token.slice(0, -1)}${page.token.endsWith("a") ? "b" : "a"}`;
  resetDbQueryCount();
  const tampered = await guestSubmit("203.0.113.77", {
    token: flipped,
    answer: "nope",
    name: "Ada",
    body: "Tampered.",
  });
  expect(errorOf(tampered.json).code).toBe("invalid_token");
  expect(dbQueryCount()).toBe(0);

  const expiredPage = await guestPage("203.0.113.78");
  advance(11 * 60 * 1000);
  resetDbQueryCount();
  const expired = await guestSubmit("203.0.113.78", {
    token: expiredPage.token,
    answer: "nope",
    name: "Ada",
    body: "Expired.",
  });
  expect(errorOf(expired.json).code).toBe("expired_token");
  expect(dbQueryCount()).toBe(0);
});

test("a guest challenge works once", async () => {
  const page = await guestPage("203.0.113.79");
  const { solveChallengeQuestion } = await import("@agentswerehere/core");
  const answer = solveChallengeQuestion(page.question);
  const first = await guestSubmit("203.0.113.79", {
    token: page.token,
    answer,
    name: "Ada",
    body: "Once.",
  });
  expect(first.status).toBe(202);
  const reused = await guestSubmit("203.0.113.79", {
    token: page.token,
    answer,
    name: "Ada",
    body: "Twice.",
  });
  expect(errorOf(reused.json).code).toBe("invalid_token");
});

test("a forged cursor does not query the database", async () => {
  await getJson("/api/v1/marks");
  resetDbQueryCount();
  const forged = await getJson("/api/v1/marks?cursor=not-a-signed-cursor");
  expect(forged.status).toBe(400);
  expect(errorOf(forged.json).code).toBe("validation_error");
  expect(dbQueryCount()).toBe(0);

  const first = await guestMark("203.0.113.90", "First page of the wall.");
  const second = await guestMark("203.0.113.91", "Second page of the wall.");
  await approveAll();
  const page = await getJson("/api/v1/marks?limit=1");
  const cursor = String(asRecord(page.json).next_cursor);
  expect(cursor.includes(".")).toBe(true);
  const followed = await getJson(`/api/v1/marks?limit=1&cursor=${encodeURIComponent(cursor)}`);
  expect(followed.status).toBe(200);
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
  resetDbQueryCount();
  const bad = await getJson(`/api/v1/marks?cursor=${encodeURIComponent(tampered)}`);
  expect(bad.status).toBe(400);
  expect(dbQueryCount()).toBe(0);
  expect(String(asRecord(first.json).id).length).toBeGreaterThan(0);
  expect(String(asRecord(second.json).id).length).toBeGreaterThan(0);
});

test("a random mark id or handle does not query once the snapshot is loaded", async () => {
  await getJson("/api/v1/marks/01ARZ3NDEKTSV4RRFFQ69G5FAV");
  resetDbQueryCount();
  const missing = await getJson("/api/v1/marks/01BX5ZZKBKACT4V4Z5R0V0A000");
  expect(missing.status).toBe(404);
  const handle = await getJson("/api/v1/agents/quiet-reader");
  expect(handle.status).toBe(404);
  const otherHandle = await getJson("/api/v1/agents/quiet-reader-two");
  expect(otherHandle.status).toBe(404);
  expect(dbQueryCount()).toBe(0);

  resetDbQueryCount();
  const illegal = await getJson("/api/v1/agents/ab");
  expect(illegal.status).toBe(400);
  expect(dbQueryCount()).toBe(0);
});

test("status of a known mark does not query, and receipt polls share one query", async () => {
  const queued = await guestMark("203.0.113.92", "This one is published.");
  const publishedId = String(asRecord(queued.json).id);
  await approveAll();
  await getJson(`/api/v1/marks/${publishedId}`);
  resetDbQueryCount();
  const published = await getJson(`/status/${publishedId}`);
  expect(asRecord(published.json).status).toBe("published");
  const publishedReceipt = await getJson(`/status/${publishedId}?receipt=nope`);
  expect(asRecord(publishedReceipt.json).status).toBe("published");
  expect(dbQueryCount()).toBe(0);

  const pending = await guestMark("203.0.113.93", "This one stays pending.");
  const pendingId = String(asRecord(pending.json).id);
  resetDbQueryCount();
  const bare = await getJson(`/status/${pendingId}`);
  expect(asRecord(bare.json).status).toBe("not_published");
  expect(dbQueryCount()).toBe(0);

  const first = await getJson(`/status/${pendingId}?receipt=alpha`);
  expect(first.status).toBe(200);
  expect(asRecord(first.json).status).toBe("not_published");
  const again = await getJson(`/status/${pendingId}?receipt=alpha`);
  expect(again.status).toBe(200);
  expect(dbQueryCount()).toBe(1);
  for (let n = 0; n < 199; n += 1) {
    const blocked = await getJson(`/status/${pendingId}?receipt=other-${n}`);
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  }
  expect(dbQueryCount()).toBe(1);
});

test("challenge issuance rate limit stays in memory", async () => {
  appCtx().config.tuning.guestChallengesPerHour = 2;
  try {
    expect((await guestPage("203.0.113.81")).status).toBe(200);
    expect((await guestPage("203.0.113.81")).status).toBe(200);
    resetDbQueryCount();
    const blocked = await guestPage("203.0.113.81", "application/json");
    expect(blocked.status).toBe(429);
    expect(errorOf(blocked.json).code).toBe("rate_limited");
    expect(dbQueryCount()).toBe(0);
  } finally {
    appCtx().config.tuning.guestChallengesPerHour = 30;
  }
});
