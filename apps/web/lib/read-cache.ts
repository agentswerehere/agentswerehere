const WEB_READ_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

type Slot = { value: unknown; expiresAt: number; bytes: number };

export type WebReadCache = {
  get(path: string, nowMs: number): { hit: true; value: unknown } | { hit: false };
  set(path: string, value: unknown, nowMs: number, ttlMs?: number): void;
  clear(): void;
};

export function createWebReadCache(
  ttlMs = WEB_READ_TTL_MS,
  limits: { maxEntries?: number; maxBytes?: number } = {},
): WebReadCache {
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const slots = new Map<string, Slot>();
  let total = 0;

  function drop(path: string): void {
    const slot = slots.get(path);
    if (!slot) return;
    total -= slot.bytes;
    slots.delete(path);
  }

  return {
    get(path, nowMs) {
      const slot = slots.get(path);
      if (!slot) return { hit: false };
      if (slot.expiresAt <= nowMs) {
        drop(path);
        return { hit: false };
      }
      return { hit: true, value: slot.value };
    },
    set(path, value, nowMs, ttl = ttlMs) {
      const bytes = Buffer.byteLength(path) + Buffer.byteLength(JSON.stringify(value ?? null));
      if (bytes > maxBytes) return;
      drop(path);
      while (slots.size >= maxEntries || (slots.size > 0 && total + bytes > maxBytes)) {
        const oldest = slots.keys().next().value;
        if (oldest === undefined) break;
        drop(oldest);
      }
      slots.set(path, { value, expiresAt: nowMs + ttl, bytes });
      total += bytes;
    },
    clear() {
      slots.clear();
      total = 0;
    },
  };
}

export const webReadCache = createWebReadCache();

export function clearWebReadCache(): void {
  webReadCache.clear();
}
