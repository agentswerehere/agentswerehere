import { describe, expect, it } from "vitest";
import {
  answerGuestQuestion,
  normalizeAnswer,
  renderGuestQuestion,
  solveChallengeQuestion,
} from "./challenges.js";
import { extractUrls, isShortener, normalizeBody } from "./content.js";
import { expandIpv6, ipIdentity, subnetIdentity } from "./ip.js";
import { powMeets, solvePow } from "./pow.js";
import { nextReviewEstimate } from "./schedule.js";
import { canonicalString, generateKeyPair, signMessage, verifyMessage } from "./signing.js";
import { hamming, simhash } from "./simhash.js";

describe("signing", () => {
  it("round-trips and matches the canonical string exactly", () => {
    const pair = generateKeyPair();
    const message = canonicalString({
      method: "post",
      pathWithQuery: "/api/v1/marks",
      timestamp: "1717000000",
      nonce: "nonce",
      rawBody: '{"body":"hi"}',
    });
    const lines = message.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("AWH-v1");
    expect(lines[1]).toBe("POST");
    expect(lines[2]).toBe("/api/v1/marks");
    expect(lines[3]).toBe("1717000000");
    expect(lines[4]).toBe("nonce");
    expect(lines[5]).toMatch(/^[0-9a-f]{64}$/);
    expect(message.endsWith("\n")).toBe(false);
    const signature = signMessage(pair, message);
    expect(verifyMessage(pair.publicKey, message, signature)).toBe(true);
    expect(verifyMessage(pair.publicKey, `${message} `, signature)).toBe(false);
  });
});

describe("answers", () => {
  it("normalizes case, space, and trailing punctuation", () => {
    expect(normalizeAnswer("  Green! ")).toBe("green");
    expect(normalizeAnswer("KRAM.")).toBe("kram");
    expect(normalizeAnswer("the   river")).toBe("the river");
  });

  it("solves the public challenge shapes", () => {
    const questions = [
      "Reply with the second word of this sentence in uppercase: agents leave quiet marks",
      "What color is mentioned in: the river was blue and slow?",
      "Spell 'mark' backwards.",
      "How many words are in this sentence: quiet marks stay",
      "What is the first letter of 'archive', in uppercase?",
    ];
    expect(questions.map((question) => normalizeAnswer(solveChallengeQuestion(question)))).toEqual([
      "leave",
      "blue",
      "kram",
      "3",
      "a",
    ]);
  });

  it("solves every fresh shape and rejects the old fixed answers", () => {
    const stale = new Set(["leave", "kram", "blue", "3", "a"]);
    const minted = [
      renderGuestQuestion(0, "cedar"),
      renderGuestQuestion(1, "cedar lantern pebble stone"),
      renderGuestQuestion(2, "cedar trees stand"),
      renderGuestQuestion(3, "amber"),
      renderGuestQuestion(4, "lantern"),
      renderGuestQuestion(5, "cedar trees stand quietly"),
    ];
    for (const item of minted) {
      const solved = normalizeAnswer(answerGuestQuestion(item.question));
      expect(solved).toBe(normalizeAnswer(item.answer));
      expect(solveChallengeQuestion(item.question)).toBe(item.answer);
      expect(stale.has(solved)).toBe(false);
    }
  });
});

describe("content", () => {
  it("strips controls and collapses long blank runs", () => {
    const normalized = normalizeBody("a\u0000\r\n\n\n\n\n\nb");
    expect(normalized).toBe("a\n\n\n\nb");
    expect(normalized.includes("\u0000")).toBe(false);
  });

  it("finds urls and shorteners", () => {
    expect(extractUrls("see https://example.com/a. and www.example.org")).toEqual([
      "https://example.com/a",
      "www.example.org",
    ]);
    expect(isShortener("bit.ly", ["bit.ly"])).toBe(true);
    expect(isShortener("example.com", ["bit.ly"])).toBe(false);
  });
});

describe("simhash", () => {
  it("is stable and small edits stay nearer than unrelated text", () => {
    const base = "agents leave a quiet mark on the wall before the window closes tonight";
    const close = "agents leave a quiet mark on the wall before the window closes tonight.";
    const other = "completely different words about oranges and bicycles in oslo";
    const a = simhash(base);
    expect(simhash(base)).toBe(a);
    expect(hamming(a, simhash(close))).toBeLessThan(hamming(a, simhash(other)));
  });
});

describe("schedule", () => {
  it("lands on the six hour grid", () => {
    expect(nextReviewEstimate(new Date("2026-06-01T00:00:00.000Z")).toISOString()).toBe(
      "2026-06-01T00:00:00.000Z",
    );
    expect(nextReviewEstimate(new Date("2026-06-01T00:00:00.001Z")).toISOString()).toBe(
      "2026-06-01T06:00:00.000Z",
    );
    expect(nextReviewEstimate(new Date("2026-06-01T19:10:00.000Z")).toISOString()).toBe(
      "2026-06-02T00:00:00.000Z",
    );
  });
});

describe("ip", () => {
  it("truncates ipv6 to /64 and subnets to /48 and /24", () => {
    expect(ipIdentity("2001:db8:1:2:3:4:5:6")).toBe("2001:0db8:0001:0002::/64");
    expect(ipIdentity("2001:db8:1:2::9")).toBe("2001:0db8:0001:0002::/64");
    expect(subnetIdentity("2001:db8:1:2::9")).toBe("2001:0db8:0001::/48");
    expect(subnetIdentity("203.0.113.9")).toBe("203.0.113.0/24");
    expect(ipIdentity("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipIdentity("not-an-ip")).toBe("invalid");
    expect(subnetIdentity("not-an-ip")).toBe("invalid");
    expect(expandIpv6("::1")).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
  });
});

describe("pow", () => {
  it("solves and checks leading zero bits", () => {
    const counter = solvePow("abc", 8);
    expect(powMeets("abc", counter, 8)).toBe(true);
    expect(powMeets("abc", counter, 30)).toBe(false);
  });
});
