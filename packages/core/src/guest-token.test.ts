import { describe, expect, test } from "vitest";
import { issueGuestToken, readGuestToken, renderGuestQuestion } from "./challenges.js";
import { guestTokenNote } from "./notices.js";

const secret = "test-secret";
const now = Date.parse("2026-06-01T03:10:00.000Z");
const material = {
  words: ["zephyr", "cedar"],
  sentences: ["cedar trees stand"],
  colors: ["amber"],
};

function issued(expiresAtMs = now + 10 * 60 * 1000, nonce?: Buffer) {
  return issueGuestToken({ secret, expiresAtMs, material, nonce });
}

describe("guest challenge tokens", () => {
  test("a signed token reads back the derived claims", () => {
    const nonce = Buffer.from("ab".repeat(12), "hex");
    const made = issued(now + 10 * 60 * 1000, nonce);
    const read = readGuestToken(made.token, secret, now, material);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.claims.kind).toBe(made.kind);
    expect(read.claims.piece).toBe(made.piece);
    expect(read.claims.nonce).toBe(nonce.toString("hex"));
    expect(renderGuestQuestion(read.claims.kind, read.claims.piece).question).toBe(made.question);
  });

  test("the payload does not contain the word, the answer, or a question index", () => {
    const nonce = Buffer.alloc(12);
    let sawWord = false;
    for (let n = 0; n < 64; n += 1) {
      nonce.writeUInt32BE(n, 8);
      const made = issued(now + 60_000, Buffer.from(nonce));
      const raw = Buffer.from(made.token, "base64url");
      const visible = `${made.token}\n${raw.toString("utf8")}`;
      expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(made.token.includes(".")).toBe(false);
      expect(raw.length).toBe(32);
      expect(visible).not.toContain(made.piece);
      expect(visible).not.toContain(made.question);
      expect(visible).not.toContain('"a"');
      expect(visible).not.toContain('"k"');
      expect(visible).not.toContain('"q"');
      expect(() => JSON.parse(raw.toString("utf8"))).toThrow();
      const answer = renderGuestQuestion(made.kind, made.piece).answer;
      if (answer.length >= 4) expect(visible.toLowerCase()).not.toContain(answer.toLowerCase());
      if (made.piece === "zephyr") sawWord = true;
    }
    expect(sawWord).toBe(true);
  });

  test("the same token draws a different word from a different list", () => {
    const nonce = Buffer.alloc(12);
    const zephyr = { words: ["zephyr"], sentences: ["cedar trees stand"], colors: ["amber"] };
    const cedar = { words: ["cedar"], sentences: ["cedar trees stand"], colors: ["amber"] };
    for (let n = 0; n < 64; n += 1) {
      nonce.writeUInt32BE(n, 0);
      const left = issueGuestToken({
        secret,
        expiresAtMs: now + 60_000,
        material: zephyr,
        nonce: Buffer.from(nonce),
      });
      if (left.kind !== 0 && left.kind !== 4) continue;
      const right = issueGuestToken({
        secret,
        expiresAtMs: now + 60_000,
        material: cedar,
        nonce: Buffer.from(nonce),
      });
      expect(left.piece).toBe("zephyr");
      expect(right.piece).toBe("cedar");
      expect(right.token).toBe(left.token);
      expect(left.token).not.toContain("zephyr");
      return;
    }
    throw new Error("expected a word-shaped challenge");
  });

  test("a tampered signature is rejected", () => {
    const made = issued();
    const flipped = `${made.token.slice(0, -1)}${made.token.endsWith("a") ? "b" : "a"}`;
    expect(readGuestToken(flipped, secret, now, material)).toEqual({
      ok: false,
      reason: "tampered",
    });
  });

  test("an expired token is rejected", () => {
    const made = issued(now - 1000);
    expect(readGuestToken(made.token, secret, now, material)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("a different secret is rejected", () => {
    expect(readGuestToken(issued().token, "other-secret", now, material).ok).toBe(false);
  });

  test("a payload that names a question index is rejected", () => {
    const legacy = `v1.${Buffer.from(JSON.stringify({ q: 2, a: "zephyr" })).toString("base64url")}.sig`;
    expect(readGuestToken(legacy, secret, now, material)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("guest token note", () => {
  test("names the issuing site and says the token is not a secret", () => {
    expect(guestTokenNote("https://agentswerehere.com")).toBe(
      "This token is a one-time challenge issued by agentswerehere.com for this page view. It contains no secrets and no data about you. It expires in about 10 minutes. It is meant to be sent back to this site with your answer.",
    );
  });
});
