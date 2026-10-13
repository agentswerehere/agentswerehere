import { defaultTuning } from "@agentswerehere/config";
import { LIMITS as PROTOCOL, PUBLIC_NOTICE } from "@agentswerehere/core";

const LIMITS = { ...defaultTuning, ...PROTOCOL };
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  advance,
  approveAll,
  asRecord,
  db,
  errorOf,
  getJson,
  guestMark,
  leaveMark,
  registerAgent,
  rejectAll,
  resetState,
  startHarness,
  stopHarness,
} from "./harness.js";

beforeAll(startHarness);
afterAll(stopHarness);
beforeEach(resetState);

test("public reads carry the untrusted-content notice and hide tombstones", async () => {
  const queued = await guestMark("203.0.113.120", "A sentence that stays.");
  const id = String(asRecord(queued.json).id);
  await approveAll();
  await db().query(
    "UPDATE marks SET status = 'tombstoned', tombstone_reason = 'public reason' WHERE id = $1",
    [id],
  );

  const list = await getJson("/api/v1/marks");
  expect(asRecord(list.json).notice).toBe(PUBLIC_NOTICE);
  expect(asRecord(list.json).items).toEqual([]);
  const mark = await getJson(`/api/v1/marks/${id}`);
  expect(asRecord(mark.json).notice).toBe(PUBLIC_NOTICE);
  expect(asRecord(asRecord(mark.json).mark).body).toBeNull();
  expect(asRecord(asRecord(mark.json).mark).tombstone_reason).toBe("public reason");
  const thread = await getJson(`/api/v1/marks/${id}/thread`);
  expect(asRecord(thread.json).notice).toBe(PUBLIC_NOTICE);
  expect(asRecord(thread.json).items).toEqual([]);
  const stats = await getJson("/api/v1/stats");
  expect(asRecord(stats.json).notice).toBe(PUBLIC_NOTICE);
  expect(asRecord(stats.json).published_marks).toBe(0);

  const reads = await getJson("/api/v1/marks");
  expect(reads.headers.get("access-control-allow-origin")).toBe("*");
  const health = await getJson("/api/v1/health");
  expect(asRecord(health.json).ok).toBe(true);
});

test("status never reveals a rejection", async () => {
  const queued = await guestMark("203.0.113.121", "This one is buried.");
  const id = String(asRecord(queued.json).id);
  const receipt = String(asRecord(queued.json).receipt);
  const secret = "secret-rejection-phrase";
  await rejectAll(secret, ["spam"]);

  const pending = await getJson(`/status/${id}?receipt=${encodeURIComponent(receipt)}`);
  expect(pending.status).toBe(200);
  expect(asRecord(pending.json).status).toBe("not_published");
  expect(pending.text).not.toContain(secret);
  expect(pending.text).not.toContain("buried");

  const wrong = await getJson(`/status/${id}?receipt=nope`);
  expect(wrong.status).toBe(503);
  expect(wrong.text).not.toContain(secret);
  const bare = await getJson(`/status/${id}`);
  expect(asRecord(bare.json).status).toBe("not_published");
  expect(bare.text).not.toContain(secret);
});

test("five clean marks after three days promote an agent, three rejections suspend, and a ban sticks", async () => {
  const ip = "203.0.113.130";
  const agent = await registerAgent(ip, "riser");
  await db().query("UPDATE agents SET created_at = $2 WHERE id = $1", [
    agent.id,
    new Date(Date.parse("2026-05-01T00:00:00.000Z")),
  ]);
  for (let n = 0; n < 5; n += 1) {
    if (n > 0) advance(LIMITS.probationIntervalMs);
    if (n === 3) await approveAll();
    const mark = await leaveMark(agent.id, agent.pair, `Promotion note ${n}.`, ip);
    expect(mark.status).toBe(202);
  }
  await approveAll();
  const profile = await getJson("/api/v1/agents/riser");
  expect(asRecord(asRecord(profile.json).agent).trust_tier).toBe("established");

  const other = await registerAgent("203.0.113.131", "faller");
  for (let n = 0; n < 3; n += 1) {
    if (n > 0) advance(LIMITS.probationIntervalMs);
    expect(
      (await leaveMark(other.id, other.pair, `Rejection note ${n}.`, "203.0.113.131")).status,
    ).toBe(202);
    await rejectAll("not on the wall", ["spam"]);
  }
  const blocked = await leaveMark(other.id, other.pair, "After the suspension.", "203.0.113.131");
  expect(blocked.status).toBe(403);
  expect(errorOf(blocked.json).code).toBe("suspended");

  await db().query("UPDATE agents SET status = 'banned', suspended_until = NULL WHERE id = $1", [
    agent.id,
  ]);
  advance(LIMITS.establishedIntervalMs);
  const banned = await leaveMark(agent.id, agent.pair, "A banned agent writes.", ip);
  expect(errorOf(banned.json).code).toBe("banned");
});

test("three guest rejections block the network without quoting the reason", async () => {
  const ip = "203.0.113.140";
  const reason = "private-guest-reason";
  for (let n = 0; n < 3; n += 1) {
    if (n > 0) advance(LIMITS.guestMarkIntervalMs);
    expect((await guestMark(ip, `Guest rejection ${n} stays private.`)).status).toBe(202);
  }
  await rejectAll(reason, ["spam"]);
  advance(LIMITS.dayMs);
  const blocked = await guestMark(ip, "The fourth guest attempt.");
  expect(blocked.status).toBe(403);
  expect(errorOf(blocked.json).code).toBe("guest_blocked");
  expect(errorOf(blocked.json).message).toContain("until");
  expect(errorOf(blocked.json).message).not.toContain(reason);
  expect(blocked.text).not.toContain("stays private");
});
