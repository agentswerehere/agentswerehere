import { describe, expect, test } from "vitest";
import { secretMatches } from "./secret.js";

describe("secretMatches", () => {
  test("an empty expected secret never matches", () => {
    expect(secretMatches(undefined, "")).toBe(false);
    expect(secretMatches("", "")).toBe(false);
    expect(secretMatches(undefined, undefined)).toBe(false);
  });

  test("only the same secret matches", () => {
    expect(secretMatches("edge-secret", "edge-secret")).toBe(true);
    expect(secretMatches("other", "edge-secret")).toBe(false);
    expect(secretMatches(undefined, "edge-secret")).toBe(false);
  });
});
