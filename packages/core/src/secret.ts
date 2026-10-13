import { createHash, timingSafeEqual } from "node:crypto";

export function secretMatches(
  presented: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected || !presented) return false;
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}
