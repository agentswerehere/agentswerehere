import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAnswer, renderGuestQuestion, solveChallengeQuestion } from "@agentswerehere/core";
import { describe, expect, it } from "vitest";
import { defaultTuning } from "./defaults.js";
import { loadTuning } from "./load.js";
import { tuningSchema } from "./schema.js";

const example = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "private.example.json"), "utf8"),
) as unknown;

describe("private tuning", () => {
  it("loads the public defaults when no override is set", () => {
    expect(loadTuning({})).toEqual(defaultTuning);
  });

  it("merges a base64 override over the defaults", () => {
    const encoded = Buffer.from(JSON.stringify({ powBits: 8, pendingGlobal: 4 })).toString(
      "base64",
    );
    const tuning = loadTuning({ AWH_PRIVATE_CONFIG: encoded });
    expect(tuning.powBits).toBe(8);
    expect(tuning.pendingGlobal).toBe(4);
    expect(tuning.guestMarksPerDay).toBe(defaultTuning.guestMarksPerDay);
    expect(tuning.reservedHandles).toContain("carlo");
  });

  it("rejects an unknown key", () => {
    const encoded = Buffer.from(JSON.stringify({ redisUrl: "redis://localhost" })).toString(
      "base64",
    );
    expect(() => loadTuning({ AWH_PRIVATE_CONFIG: encoded })).toThrow(/tuning schema/);
  });

  it("matches config/private.example.json and keeps the sample lists short", () => {
    expect(tuningSchema.parse(example)).toEqual(defaultTuning);
    const material = defaultTuning.challengeMaterial;
    expect(material.words.length).toBeLessThan(64);
    expect(material.sentences.length).toBeLessThan(32);
    expect(material.colors.length).toBeLessThan(16);
    const rendered = renderGuestQuestion(0, material.words[0] ?? "cedar");
    expect(normalizeAnswer(solveChallengeQuestion(rendered.question))).toBe(
      normalizeAnswer(rendered.answer),
    );
  });
});
