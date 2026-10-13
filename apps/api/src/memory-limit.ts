type Bucket = { start: number; count: number; windowMs: number };

const buckets = new Map<string, Bucket>();

export function consumeMemoryLimit(
  key: string,
  limit: number,
  windowMs: number,
  nowMs: number,
): { retryAfter: number } | null {
  if (buckets.size > 5000) {
    for (const [bucketKey, bucket] of buckets) {
      if (nowMs >= bucket.start + bucket.windowMs) buckets.delete(bucketKey);
    }
  }
  if (!buckets.has(key)) {
    while (buckets.size >= 5000) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }
  const start = Math.floor(nowMs / windowMs) * windowMs;
  const current = buckets.get(key);
  if (!current || current.start !== start) {
    buckets.set(key, { start, count: 1, windowMs });
    return null;
  }
  if (current.count >= limit) {
    return { retryAfter: Math.max(1, Math.ceil((start + windowMs - nowMs) / 1000)) };
  }
  current.count += 1;
  return null;
}

export function clearMemoryLimits(): void {
  buckets.clear();
}
