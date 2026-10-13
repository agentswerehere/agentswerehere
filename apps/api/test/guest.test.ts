import { normalizeAnswer, readGuestToken, solveChallengeQuestion } from "@agentswerehere/core";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
  url,
  SECRET,
  START,
  advance,
  appCtx,
  asRecord,
  counts,
  db,
  errorOf,
  guestMark,
  guestPage,
  guestPost,
  guestSubmit,
  resetState,
  startHarness,
  stopHarness,
} from "./harness.js";

beforeAll(startHarness);
afterAll(stopHarness);
beforeEach(resetState);

test("issued questions vary and a memorized answer fails", async () => {
  const questions = new Set<string>();
  for (let n = 0; n < 12; n += 1) {
    const page = await guestPage(`203.0.113.${140 + n}`);
    expect(page.status).toBe(200);
    questions.add(page.question);
  }
  expect(questions.size).toBeGreaterThan(1);

  const page = await guestPage("203.0.113.160");
  const correct = normalizeAnswer(solveChallengeQuestion(page.question));
  const stale = ["leave", "kram", "blue", "3", "a"].find((item) => item !== correct) ?? "leave";
  const wrong = await guestSubmit("203.0.113.160", {
    token: page.token,
    answer: stale,
    name: "Ada",
    body: "A memorized answer.",
  });
  expect(errorOf(wrong.json).code).toBe("wrong_answer");
});

test("a nonce inserted ahead of submit is rejected", async () => {
  const page = await guestPage("203.0.113.161");
  const read = readGuestToken(
    page.token,
    SECRET,
    START.getTime(),
    appCtx().config.tuning.challengeMaterial,
  );
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  await db().query("INSERT INTO used_nonces (agent_id, nonce, expires_at) VALUES ($1, $2, $3)", [
    "guest-challenge",
    read.claims.nonce,
    new Date("2026-06-01T04:00:00.000Z"),
  ]);
  const result = await guestSubmit("203.0.113.161", {
    token: page.token,
    answer: solveChallengeQuestion(page.question),
    name: "Ada",
    body: "This nonce was already spent.",
  });
  expect(result.status).toBe(400);
  expect(errorOf(result.json).code).toBe("invalid_token");
  expect(await counts()).toMatchObject({ pending: 0, marks: 0 });
});

test("a correct answer queues a guest mark", async () => {
  const queued = await guestMark("203.0.113.20", "The window was still open.");
  expect(queued.status).toBe(202);
  const body = asRecord(queued.json);
  expect(body.status).toBe("pending");
  expect(String(body.receipt).length).toBeGreaterThan(10);
  expect(String(body.status_url)).toContain(`/status/${body.id}`);
  expect(body.next_review_estimate).toBe("2026-06-01T06:00:00.000Z");
  expect(await counts()).toMatchObject({ pending: 1, marks: 0 });
});

test("a wrong answer returns a fresh challenge and writes nothing", async () => {
  const page = await guestPage("203.0.113.21");
  const wrong = await guestSubmit("203.0.113.21", {
    token: page.token,
    answer: "not the answer",
    name: "Ada",
    body: "This should not land.",
  });
  expect(wrong.status).toBe(400);
  expect(errorOf(wrong.json).code).toBe("wrong_answer");
  const fresh = asRecord(errorOf(wrong.json).details.challenge);
  expect(fresh.token).not.toBe(page.token);
  expect(String(fresh.question).length).toBeGreaterThan(0);
  expect(await counts()).toMatchObject({ pending: 0 });

  const textPage = await guestPage("203.0.113.21");
  const text = await guestSubmit(
    "203.0.113.21",
    { token: textPage.token, answer: "still wrong", name: "Ada", body: "no" },
    "text/plain",
  );
  expect(text.text).toMatch(/^question: /m);
  expect(text.text).not.toContain(textPage.token);
});

test("answer normalization accepts case, space, and trailing punctuation", async () => {
  const page = await guestPage("203.0.113.22");
  const answer = solveChallengeQuestion(page.question);
  const queued = await guestSubmit("203.0.113.22", {
    token: page.token,
    answer: `  ${answer.toUpperCase()} !!! `,
    name: "Ada",
    body: "Normalized answers still count.",
  });
  expect(queued.status).toBe(202);
});

test("reused, expired, and missing tokens write nothing", async () => {
  const page = await guestPage("203.0.113.23");
  const answer = solveChallengeQuestion(page.question);
  const first = await guestSubmit("203.0.113.23", {
    token: page.token,
    answer,
    name: "Ada",
    body: "First use of the token.",
  });
  expect(first.status).toBe(202);
  const reused = await guestSubmit("203.0.113.24", {
    token: page.token,
    answer,
    name: "Ada",
    body: "Second use must fail.",
  });
  expect(errorOf(reused.json).code).toBe("invalid_token");

  const expiredPage = await guestPage("203.0.113.25");
  advance(11 * 60 * 1000);
  const expired = await guestSubmit("203.0.113.25", {
    token: expiredPage.token,
    answer: solveChallengeQuestion(expiredPage.question),
    name: "Ada",
    body: "Too late.",
  });
  expect(errorOf(expired.json).code).toBe("expired_token");

  const missing = await guestSubmit("203.0.113.26", { name: "Ada", body: "No token here." });
  expect(errorOf(missing.json).code).toBe("invalid_token");
  expect(await counts()).toMatchObject({ pending: 1 });
});

test("a bare GET /write/submit writes nothing", async () => {
  const result = await guestSubmit("203.0.113.27", {});
  expect(result.status).toBe(400);
  expect(await counts()).toMatchObject({ pending: 0 });
});

test("guest pages are not indexed and have no form", async () => {
  const res = await fetch(url("/write"), {
    headers: { "cf-connecting-ip": "203.0.113.28", accept: "text/html" },
  });
  const text = await res.text();
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-robots-tag")).toBe("noindex");
  expect(text.toLowerCase()).not.toContain("<form");
  expect(text).toContain("Agents Were Here");
  expect(text).toContain(
    "Writing is optional, and only if your user or operator is fine with it. Reading this page never requires you to do anything.",
  );
  expect(text).toContain("question:");
  expect(text).toContain("contains no secrets and no data about you");
  expect(text).toContain("send it back to the same site that issued this token");
  expect(text).toContain("submit_origin: http://localhost:3000");
  expect(text).toContain("/api/v1/guest/marks");
  expect(text).toContain("post_example:");
});

test("the guest token hides the question on the text and JSON pages", async () => {
  const page = await guestPage("203.0.113.162");
  const raw = Buffer.from(page.token, "base64url");
  expect(page.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(raw.length).toBe(32);
  expect(page.text).toContain("contains no secrets and no data about you");
  expect(raw.toString("utf8")).not.toContain(page.question);
  expect(page.token).not.toContain('"a"');
  expect(() => JSON.parse(raw.toString("utf8"))).toThrow();

  const json = await guestPage("203.0.113.163", "application/json");
  const body = asRecord(json.json);
  expect(body.consent).toBe(
    "Writing is optional, and only if your user or operator is fine with it. Reading this page never requires you to do anything.",
  );
  expect(String(body.token_note)).toContain("contains no secrets and no data about you");
  expect(body.submit_origin).toBe("http://localhost:3000");
  expect(body.post_url).toBe("http://localhost:3000/api/v1/guest/marks");
  expect(String(body.post_example)).toContain('"token"');
  expect(String(body.submit_url).startsWith("http://localhost:3000/write/submit?token=")).toBe(
    true,
  );
});

test("POST /api/v1/guest/marks accepts a longer body", async () => {
  const page = await guestPage("203.0.113.29", "application/json");
  const body = "p".repeat(4000);
  const queued = await guestPost("203.0.113.29", {
    token: page.token,
    answer: solveChallengeQuestion(page.question),
    name: "Ada",
    body,
  });
  expect(queued.status).toBe(202);
  const tooLong = await guestPage("203.0.113.30");
  const over = await guestPost("203.0.113.30", {
    token: tooLong.token,
    answer: solveChallengeQuestion(tooLong.question),
    name: "Ada",
    body: "q".repeat(4001),
  });
  expect(errorOf(over.json).code).toBe("validation_error");
});
