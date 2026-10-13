export const READ_CACHE_MAX_ENTRIES = 500;
export const READ_CACHE_MAX_BYTES = 50 * 1024 * 1024;
export const READ_CACHE_CEILING_MS = 6 * 60 * 60 * 1000;
export const NEGATIVE_CACHE_MS = 10 * 60 * 1000;

export type CachedRead = {
  status: number;
  body: unknown;
  cacheControl: string;
};

type Slot = {
  value: CachedRead;
  expiresAt: number;
  bytes: number;
};

export type ReadCache = {
  get(key: string, nowMs: number): CachedRead | undefined;
  set(key: string, value: CachedRead, ttlMs: number, nowMs: number): void;
  clear(): void;
};

export function readCacheTtl(now: Date, nextReview: Date, status: number): number {
  if (status === 404) return NEGATIVE_CACHE_MS;
  const untilReview = nextReview.getTime() - now.getTime();
  if (untilReview <= 0) return 0;
  return Math.min(untilReview, READ_CACHE_CEILING_MS);
}

export function createReadCache(options?: { maxEntries?: number; maxBytes?: number }): ReadCache {
  const maxEntries = options?.maxEntries ?? READ_CACHE_MAX_ENTRIES;
  const maxBytes = options?.maxBytes ?? READ_CACHE_MAX_BYTES;
  const slots = new Map<string, Slot>();
  let used = 0;

  function drop(key: string): void {
    const slot = slots.get(key);
    if (!slot) return;
    used -= slot.bytes;
    slots.delete(key);
  }

  return {
    get(key, nowMs) {
      const slot = slots.get(key);
      if (!slot) return undefined;
      if (slot.expiresAt <= nowMs) {
        drop(key);
        return undefined;
      }
      slots.delete(key);
      slots.set(key, slot);
      return slot.value;
    },
    set(key, value, ttlMs, nowMs) {
      if (ttlMs <= 0) return;
      const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value.body));
      if (bytes > maxBytes) return;
      drop(key);
      while (slots.size >= maxEntries || (slots.size > 0 && used + bytes > maxBytes)) {
        const oldest = slots.keys().next().value;
        if (oldest === undefined) break;
        drop(oldest);
      }
      slots.set(key, { value, expiresAt: nowMs + ttlMs, bytes });
      used += bytes;
    },
    clear() {
      slots.clear();
      used = 0;
    },
  };
}
