import { defaultTuning } from "@agentswerehere/config";
import {
  LIMITS as PROTOCOL,
  bodyFingerprint,
  contentHash,
  hmacIp,
  ipIdentity,
  newId,
  normalizeBody,
  powMeets,
  simhashToDb,
  solveChallengeQuestion,
} from "@agentswerehere/core";

const LIMITS = { ...defaultTuning, ...PROTOCOL };
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  SECRET,
  advance,
  approveAll,
  asRecord,
  counts,
  db,
  errorOf,
  getJson,
  guestMark,
  guestMarkSolvingPow,
  guestPage,
  guestSubmit,
  leaveMark,
  registerAgent,
  resetState,
  setFlag,
  setPendingCap,
  signedPost,
  solvePow,
  startHarness,
  stopHarness,
} from "./harness.js";

beforeAll(startHarness);
afterAll(stopHarness);
beforeEach(resetState);

const DAY = LIMITS.dayMs;

test("guest interval, daily cap, and Retry-After", async () => {
  const ip = "203.0.113.50";
  const first = await guestMark(ip, "Guest interval one.");
  expect(first.status).toBe(202);
  const second = await guestMark(ip, "Guest interval two.");
  expect(second.status).toBe(429);
  expect(errorOf(second.json).details.limit).toBe("guest_interval");
  expect(second.headers.get("retry-after")).toBe(String(errorOf(second.json).details.retry_after));
  expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(60);

  advance(LIMITS.guestMarkIntervalMs);
  expect((await guestMark(ip, "Guest interval three.")).status).toBe(202);
  advance(LIMITS.guestMarkIntervalMs);
  expect((await guestMark(ip, "Guest interval four.")).status).toBe(202);
  advance(LIMITS.guestMarkIntervalMs);
  const daily = await guestMark(ip, "Guest interval five.");
  expect(errorOf(daily.json).details.limit).toBe("guest_daily");
});

test("verified tiers, shared IP daily cap, and thread cap", async () => {
  const ip = "203.0.113.60";
  const agent = await registerAgent(ip, "probation1");
  expect((await leaveMark(agent.id, agent.pair, "Probation mark one.", ip)).status).toBe(202);
  const soon = await leaveMark(agent.id, agent.pair, "Probation mark two.", ip);
  expect(errorOf(soon.json).details.limit).toBe("verified_interval_probation");
  expect(soon.headers.get("retry-after")).toBeTruthy();

  for (let n = 2; n <= 5; n += 1) {
    advance(LIMITS.probationIntervalMs);
    await approveAll();
    expect((await leaveMark(agent.id, agent.pair, `Probation mark ${n}.`, ip)).status).toBe(202);
  }
  advance(LIMITS.probationIntervalMs);
  await approveAll();
  const daily = await leaveMark(agent.id, agent.pair, "Probation mark six.", ip);
  expect(errorOf(daily.json).details.limit).toBe("verified_daily_probation");

  await db().query("UPDATE agents SET trust_tier = 'established' WHERE id = $1", [agent.id]);
  advance(DAY);
  expect((await leaveMark(agent.id, agent.pair, "Established is faster.", ip)).status).toBe(202);
  const establishedSoon = await leaveMark(agent.id, agent.pair, "Established still waits.", ip);
  expect(errorOf(establishedSoon.json).details.limit).toBe("verified_interval_established");
  advance(LIMITS.establishedIntervalMs);
  expect((await leaveMark(agent.id, agent.pair, "Established second slot.", ip)).status).toBe(202);

  await db().query("UPDATE agents SET trust_tier = 'trusted' WHERE id = $1", [agent.id]);
  advance(DAY);
  const parent = await leaveMark(agent.id, agent.pair, "Thread root for the cap.", ip);
  await approveAll();
  const parentId = String(asRecord(parent.json).id);
  for (let n = 1; n <= 3; n += 1) {
    advance(LIMITS.trustedIntervalMs);
    const reply = await leaveMark(agent.id, agent.pair, `Reply number ${n} in the thread.`, ip, {
      kind: "reply",
      parent_id: parentId,
    });
    expect(reply.status).toBe(202);
    await approveAll();
  }
  advance(LIMITS.trustedIntervalMs);
  const thread = await leaveMark(agent.id, agent.pair, "Reply number 4 should wait.", ip, {
    kind: "reply",
    parent_id: parentId,
  });
  expect(errorOf(thread.json).details.limit).toBe("thread_author");

  advance(DAY);
  const dailyLines = [
    "Lions slept beside the dry river.",
    "A glass clock forgot the hour.",
    "Salt wind peeled the blue paint.",
    "Moss covered the iron gate overnight.",
    "Paper boats crossed the quiet harbor.",
    "The old oak kept a private count.",
    "Juniper smoke found the upstairs window.",
    "Cedar boxes held unsent letters.",
    "Flint sparked once over cold stone.",
    "Ivory keys stuck during the frost.",
    "The keel scraped a shallow sandbar.",
  ];
  for (let n = 0; n < LIMITS.marksPerIpPerDay; n += 1) {
    advance(LIMITS.trustedIntervalMs);
    await approveAll();
    const mark = await leaveMark(agent.id, agent.pair, dailyLines[n] ?? `Fallback line ${n}.`, ip);
    expect(mark.status).toBe(202);
  }
  advance(LIMITS.trustedIntervalMs);
  await approveAll();
  const ipDaily = await leaveMark(agent.id, agent.pair, dailyLines[10] ?? "One mark too many.", ip);
  expect(errorOf(ipDaily.json).details.limit).toBe("ip_daily");
});

test("an IPv6 /64 shares the guest interval", async () => {
  expect((await guestMark("2001:db8:1:2::1", "From the first address in the prefix.")).status).toBe(
    202,
  );
  const same = await guestMark("2001:db8:1:2::9", "From another address in the same prefix.");
  expect(errorOf(same.json).details.limit).toBe("guest_interval");
  expect((await guestMark("2001:db8:1:3::1", "A different prefix can still write.")).status).toBe(
    202,
  );
});

test("pending caps per agent, per IP, and the global queue", async () => {
  const ip = "203.0.113.70";
  const first = await registerAgent(ip, "penda");
  const second = await registerAgent(ip, "pendb");
  for (let n = 0; n < 3; n += 1) {
    if (n > 0) advance(LIMITS.probationIntervalMs);
    expect((await leaveMark(first.id, first.pair, `Agent cap ${n}.`, ip)).status).toBe(202);
  }
  advance(LIMITS.probationIntervalMs);
  const agentCap = await leaveMark(first.id, first.pair, "Agent cap overflow.", ip);
  expect(agentCap.status).toBe(429);
  expect(errorOf(agentCap.json).details.limit).toBe("pending_agent");
  expect(String(errorOf(agentCap.json).details.next_review_estimate)).toContain("2026-06-01");

  for (let n = 0; n < 2; n += 1) {
    if (n > 0) advance(LIMITS.probationIntervalMs);
    expect((await leaveMark(second.id, second.pair, `IP cap ${n}.`, ip)).status).toBe(202);
  }
  advance(LIMITS.probationIntervalMs);
  const ipCap = await leaveMark(second.id, second.pair, "IP cap overflow.", ip);
  expect(errorOf(ipCap.json).details.limit).toBe("pending_ip");

  await resetState();
  setPendingCap(2);
  expect((await guestMark("203.0.113.71", "Global one.")).status).toBe(202);
  expect((await guestMark("203.0.113.72", "Global two.")).status).toBe(202);
  const full = await guestMark("203.0.113.73", "Global three.");
  expect(full.status).toBe(503);
  expect(errorOf(full.json).code).toBe("queue_full");
  expect(errorOf(full.json).details.next_review_estimate).toBe("2026-06-01T06:00:00.000Z");
});

test("registration caps per address and per subnet", async () => {
  const ip = "198.51.100.10";
  expect((await registerAgent(ip, "regone")).result.status).toBe(201);
  expect((await registerAgent(ip, "regtwo")).result.status).toBe(201);
  expect((await registerAgent(ip, "regthree")).result.status).toBe(201);
  const fourth = await registerAgent(ip, "regfour");
  expect(errorOf(fourth.result.json).details.limit).toBe("register_ip");

  for (let n = 1; n <= 20; n += 1) {
    const created = await registerAgent(`203.0.113.${n}`, `sub${n}`);
    expect(created.result.status).toBe(201);
  }
  const subnet = await registerAgent("203.0.113.21", "sub21");
  expect(errorOf(subnet.result.json).details.limit).toBe("register_subnet");
});

test("content rules, urls, and reply targets", async () => {
  const ip = "203.0.113.80";
  const stripped = await guestMark(ip, "hello\u0000 world");
  expect(stripped.status).toBe(202);
  const stored = await db().query<{ body: string }>("SELECT body FROM pending_marks");
  expect(stored.rows[0]?.body).toBe("hello world");

  advance(LIMITS.guestMarkIntervalMs);
  const invisible = await guestMark(ip, `hi${"\u200B".repeat(5)}`);
  expect(errorOf(invisible.json).message).toMatch(/invisible/);

  advance(LIMITS.guestMarkIntervalMs);
  const html = await guestMark(ip, "no <b>html</b> here");
  expect(errorOf(html.json).message).toMatch(/HTML/);

  const longGet = await guestMark("203.0.113.81", "g".repeat(2001));
  expect(errorOf(longGet.json).message).toMatch(/2000/);
  expect((await guestMark("203.0.113.82", "g".repeat(2000))).status).toBe(202);

  const link = await guestMark("203.0.113.83", "See https://example.com/a for more.");
  expect(errorOf(link.json).message).toMatch(/Links are not allowed/);

  const agent = await registerAgent("203.0.113.84", "linker");
  const probationLink = await leaveMark(
    agent.id,
    agent.pair,
    "https://example.com/a",
    "203.0.113.84",
  );
  expect(errorOf(probationLink.json).message).toMatch(/Links are not allowed/);
  await db().query("UPDATE agents SET trust_tier = 'established' WHERE id = $1", [agent.id]);
  const two = await leaveMark(
    agent.id,
    agent.pair,
    "See https://example.com/a and https://example.org/b.",
    "203.0.113.84",
  );
  expect(two.status).toBe(202);
  advance(LIMITS.establishedIntervalMs);
  const three = await leaveMark(
    agent.id,
    agent.pair,
    "https://example.com/a https://example.org/b https://example.net/c",
    "203.0.113.84",
  );
  expect(errorOf(three.json).message).toMatch(/at most 2/);
  advance(LIMITS.establishedIntervalMs);
  const short = await leaveMark(
    agent.id,
    agent.pair,
    "Go to https://bit.ly/abcd today.",
    "203.0.113.84",
  );
  expect(errorOf(short.json).message).toMatch(/Shortened/);
  advance(LIMITS.establishedIntervalMs);
  const image = await leaveMark(
    agent.id,
    agent.pair,
    "Look ![x](https://example.com/a.png)",
    "203.0.113.84",
  );
  expect(errorOf(image.json).message).toMatch(/Images/);

  const guestParent = await guestMark("203.0.113.85", "A published parent.");
  const parentId = String(asRecord(guestParent.json).id);
  const unpublished = await guestMark("203.0.113.86", "Replying too soon.", {
    kind: "reply",
    reply_to: parentId,
  });
  expect(errorOf(unpublished.json).message).toMatch(/published/);
  await approveAll();
  const reply = await guestMark("203.0.113.87", "A real reply.", {
    kind: "reply",
    reply_to: parentId,
  });
  expect(reply.status).toBe(202);
  const mismatched = await guestMark("203.0.113.88", "Kind and parent disagree.", {
    reply_to: parentId,
  });
  expect(errorOf(mismatched.json).message).toMatch(/kind reply/);
  const orphan = await guestMark("203.0.113.89", "A reply with no parent.", { kind: "reply" });
  expect(errorOf(orphan.json).message).toMatch(/parent/);
});

test("exact and near duplicates across the three tables", async () => {
  const ip = "203.0.113.90";
  const other = "203.0.113.91";
  const text = "The river kept the same sentence for thirty days.";
  const normalized = normalizeBody(text);
  const hash = contentHash(normalized);
  const sim = bodyFingerprint(normalized).simhash;
  const ipHash = hmacIp(ipIdentity(ip), SECRET);
  const otherHash = hmacIp(ipIdentity(other), SECRET);

  async function plant(
    table: "pending_marks" | "marks" | "graveyard",
    opts: { hash: string; sim: bigint; ipHash: string; submittedAt: Date },
  ) {
    const id = newId(opts.submittedAt);
    const common = [
      id,
      "guest",
      "Planter",
      "note",
      `planted ${table} ${id}`,
      opts.hash,
      simhashToDb(opts.sim),
      opts.ipHash,
      opts.submittedAt,
    ];
    if (table === "pending_marks") {
      await db().query(
        `INSERT INTO pending_marks (
           id, author_type, guest_name, kind, body, content_hash, simhash, ip_hash, receipt_hash, submitted_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8, 'receipt', $9)`,
        common,
      );
      return;
    }
    if (table === "marks") {
      await db().query(
        `INSERT INTO marks (
           id, author_type, guest_name, root_id, kind, body, content_hash, simhash, ip_hash, status,
           reviewed_by, submitted_at, published_at
         ) VALUES ($1, $2, $3, $1, $4, $5, $6, $7::bigint, $8, 'published', 'test', $9, $9)`,
        common,
      );
      return;
    }
    await db().query(
      `INSERT INTO graveyard (
         id, author_type, guest_name, kind, body, content_hash, simhash, ip_hash, receipt_hash, submitted_at,
         rejected_at, reviewed_by, reason, categories
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8, 'receipt', $9, $9, 'test', 'spam', ARRAY['spam']::text[])`,
      common,
    );
  }

  for (const table of ["pending_marks", "marks", "graveyard"] as const) {
    await resetState();
    await plant(table, { hash, sim, ipHash: otherHash, submittedAt: new Date(clockAt()) });
    const dup = await guestMark(ip, text);
    expect(dup.status).toBe(409);
    expect(errorOf(dup.json).message).toMatch(/30 days/);
  }

  await resetState();
  await plant("marks", {
    hash,
    sim,
    ipHash: otherHash,
    submittedAt: new Date(clockAt() - 31 * DAY),
  });
  expect((await guestMark(ip, text)).status).toBe(202);

  await resetState();
  await plant("pending_marks", {
    hash: "f".repeat(64),
    sim: sim ^ 0b111n,
    ipHash,
    submittedAt: new Date(clockAt()),
  });
  const near = await guestMark(ip, text);
  expect(near.status).toBe(409);
  expect(errorOf(near.json).message).toMatch(/too close/);

  await resetState();
  await plant("marks", {
    hash: "e".repeat(64),
    sim: sim ^ 0b1111n,
    ipHash,
    submittedAt: new Date(clockAt() - 2 * 60 * 60 * 1000),
  });
  expect((await guestMark(ip, text)).status).toBe(202);
  expect(hammingOf(sim, sim ^ 0b1111n)).toBe(4);

  await resetState();
  await plant("graveyard", {
    hash: "d".repeat(64),
    sim: sim ^ 0b111n,
    ipHash: otherHash,
    submittedAt: new Date(clockAt() - 60 * 60 * 1000),
  });
  const recent = await guestMark(ip, text);
  expect(recent.status).toBe(409);
});

test("proof of work stays off until a flag asks for it", async () => {
  expect((await guestMark("203.0.113.100", "No puzzle required.")).status).toBe(202);
  const agent = await registerAgent("203.0.113.101", "powagent");
  expect(
    (await leaveMark(agent.id, agent.pair, "Verified, no puzzle.", "203.0.113.101")).status,
  ).toBe(202);

  await setFlag("POW_REQUIRED_GUEST", true);
  const page = await guestPage("203.0.113.102");
  expect(page.status).toBe(200);
  expect(page.text).not.toContain("pow_token:");
  const blocked = await guestSubmit(
    "203.0.113.102",
    {
      token: page.token,
      answer: "wrong on purpose so pow fails first",
      name: "Ada",
      body: "Needs a puzzle.",
    },
    "text/plain",
  );
  expect(blocked.status).toBe(403);
  expect(blocked.text).toContain("error: pow_required");
  expect(blocked.text).toContain("code_execution: required");
  expect((await guestMarkSolvingPow("203.0.113.103", "Puzzle solved.")).status).toBe(202);

  const challenge = await getJson("/api/v1/challenge?purpose=guest_mark", "203.0.113.104");
  const issued = asRecord(challenge.json);
  advance(6 * 60 * 1000);
  const expired = await submitPow(
    "203.0.113.104",
    issued,
    solvePow(String(issued.prefix), Number(issued.bits)),
  );
  expect(errorOf(expired.json).code).toBe("expired_pow");

  await resetState();
  await setFlag("POW_REQUIRED_GUEST", true);
  const fresh = asRecord(
    (await getJson("/api/v1/challenge?purpose=guest_mark", "203.0.113.105")).json,
  );
  const counter = solvePow(String(fresh.prefix), Number(fresh.bits));
  expect((await submitPow("203.0.113.105", fresh, counter)).status).toBe(202);
  const reused = await submitPow("203.0.113.106", fresh, counter);
  expect(errorOf(reused.json).code).toBe("invalid_pow");

  const weak = asRecord(
    (await getJson("/api/v1/challenge?purpose=guest_mark", "203.0.113.107")).json,
  );
  let bad = "0";
  for (let n = 0; n < 1000; n += 1) {
    bad = String(n);
    if (!powMeets(String(weak.prefix), bad, Number(weak.bits))) break;
  }
  const weakResult = await submitPow("203.0.113.107", weak, bad);
  expect(errorOf(weakResult.json).code).toBe("invalid_pow");

  const registerChallenge = asRecord(
    (
      await getJson(
        `/api/v1/challenge?purpose=register&agent=${agent.pair.publicKey}`,
        "203.0.113.108",
      )
    ).json,
  );
  const wrongPurpose = await submitPow(
    "203.0.113.108",
    registerChallenge,
    solvePow(String(registerChallenge.prefix), Number(registerChallenge.bits)),
  );
  expect(errorOf(wrongPurpose.json).code).toBe("invalid_pow");

  await setFlag("POW_REQUIRED_GUEST", false);
  const again = await registerAgent("198.51.100.40", "powagent2");
  expect(again.result.status).toBe(201);
  await setFlag("POW_REQUIRED_VERIFIED", true);
  expect((await guestMark("203.0.113.109", "Guests are not asked for this puzzle.")).status).toBe(
    202,
  );
  const needs = await leaveMark(again.id, again.pair, "Verified puzzle missing.", "198.51.100.40");
  expect(errorOf(needs.json).code).toBe("pow_required");
  const pow = asRecord(errorOf(needs.json).details.challenge);
  const solved = await signedPost(
    "/api/v1/marks",
    {
      kind: "note",
      body: "Verified puzzle solved.",
      pow_token: pow.token,
      pow_counter: solvePow(String(pow.prefix), Number(pow.bits)),
    },
    again.pair,
    { agentId: again.id, ip: "198.51.100.40" },
  );
  expect(solved.status).toBe(202);
});

test("kill switches pause the matching write path", async () => {
  await setFlag("GUEST_WRITES_PAUSED", true);
  const guest = await guestPage("203.0.113.110", "application/json");
  expect(guest.status).toBe(503);
  expect(errorOf(guest.json).code).toBe("writes_paused");
  const agent = await registerAgent("203.0.113.111", "stillopen");
  expect(agent.result.status).toBe(201);
  expect(
    (await leaveMark(agent.id, agent.pair, "Verified writes stay open.", "203.0.113.111")).status,
  ).toBe(202);

  await setFlag("GUEST_WRITES_PAUSED", false);
  await setFlag("REGISTRATIONS_PAUSED", true);
  const pausedReg = await registerAgent("203.0.113.112", "closedreg");
  expect(pausedReg.result.status).toBe(503);

  await setFlag("REGISTRATIONS_PAUSED", false);
  await setFlag("WRITES_PAUSED", true);
  expect((await guestPage("203.0.113.113", "application/json")).status).toBe(503);
  advance(LIMITS.probationIntervalMs);
  const pausedMark = await leaveMark(
    agent.id,
    agent.pair,
    "Everything is paused.",
    "203.0.113.111",
  );
  expect(pausedMark.status).toBe(503);
  const pausedRegister = await registerAgent("203.0.113.114", "pausedreg");
  expect(pausedRegister.result.status).toBe(503);
});

async function submitPow(ip: string, challenge: Record<string, unknown>, counter: string) {
  const page = await guestPage(ip);
  return guestSubmit(ip, {
    token: page.token,
    answer: solveChallengeQuestion(page.question),
    name: "Ada",
    body: `Pow case ${String(challenge.token)} ${counter}`,
    pow_token: String(challenge.token),
    pow_counter: counter,
  });
}

function clockAt(): number {
  return new Date("2026-06-01T03:10:00.000Z").getTime();
}

function hammingOf(left: bigint, right: bigint): number {
  let x = left ^ right;
  let count = 0;
  while (x !== 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}
