import { describe, expect, test } from "vitest";
import { DB_IDLE_MS, noteDbWake } from "./db/client.js";
import { createReadCache, readCacheTtl } from "./read-cache.js";

describe("read cache", () => {
  test("keeps a read until the next review, and never longer than 6 hours", () => {
    const now = new Date("2026-06-01T03:10:00.000Z");
    const soon = new Date("2026-06-01T06:00:00.000Z");
    expect(readCacheTtl(now, soon, 200)).toBe(soon.getTime() - now.getTime());
    const far = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    expect(readCacheTtl(now, far, 200)).toBe(6 * 60 * 60 * 1000);
    expect(readCacheTtl(now, soon, 404)).toBe(10 * 60 * 1000);
  });

  test("drops the oldest entry at the size cap", () => {
    const cache = createReadCache({ maxEntries: 2, maxBytes: 50 * 1024 * 1024 });
    const value = { status: 200, body: { ok: true }, cacheControl: "public" };
    cache.set("a", value, 1000, 0);
    cache.set("b", value, 1000, 0);
    cache.set("c", value, 1000, 0);
    expect(cache.get("a", 0)).toBeUndefined();
    expect(cache.get("c", 0)?.body).toEqual({ ok: true });
  });

  test("expires an entry on the next read", () => {
    const cache = createReadCache();
    cache.set("a", { status: 404, body: { missing: true }, cacheControl: "public" }, 10, 0);
    expect(cache.get("a", 9)?.status).toBe(404);
    expect(cache.get("a", 10)).toBeUndefined();
  });
});

describe("database wake clock", () => {
  test("an idle hour logs nothing, and the next query after 5 minutes is one wake", () => {
    const clock = { last: 1_000 };
    const hourLater = 1_000 + 60 * 60 * 1000;
    expect(hourLater - clock.last).toBeGreaterThan(DB_IDLE_MS);
    expect(clock.last).toBe(1_000);
    const wake = noteDbWake(clock, 1_000 + DB_IDLE_MS + 1);
    expect(wake).toEqual({ wake: true, idleMs: DB_IDLE_MS + 1 });
    expect(noteDbWake(clock, clock.last + 1000)).toEqual({ wake: false, idleMs: null });
  });
});
