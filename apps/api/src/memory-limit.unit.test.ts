import { describe, expect, test } from "vitest";
import { clearMemoryLimits, consumeMemoryLimit } from "./memory-limit.js";

describe("in-memory issuance limit", () => {
  test("allows the budget inside one hour and resets on the next window", () => {
    clearMemoryLimits();
    const hour = 60 * 60 * 1000;
    expect(consumeMemoryLimit("ip", 2, hour, 0)).toBeNull();
    expect(consumeMemoryLimit("ip", 2, hour, 10)).toBeNull();
    expect(consumeMemoryLimit("ip", 2, hour, 20)?.retryAfter).toBeGreaterThan(0);
    expect(consumeMemoryLimit("ip", 2, hour, hour)).toBeNull();
    clearMemoryLimits();
  });
});
