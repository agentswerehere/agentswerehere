import { createHash } from "node:crypto";

function hash64(token: string): bigint {
  const digest = createHash("sha256").update(token).digest();
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    value = (value << 8n) | BigInt(digest[i] ?? 0);
  }
  return value;
}

/** Words plus 4-character shingles, so a small edit moves only a few bits. */
export function simhashTokens(text: string): string[] {
  const lower = text.toLowerCase();
  const words = lower.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
  const compact = words.join(" ");
  const shingles: string[] = [];
  if (compact.length <= 4) {
    if (compact.length > 0) shingles.push(compact);
  } else {
    for (let i = 0; i <= compact.length - 4; i += 1) {
      shingles.push(compact.slice(i, i + 4));
    }
  }
  return [...words.map((word) => `w:${word}`), ...shingles.map((gram) => `g:${gram}`)];
}

export function simhash(text: string): bigint {
  const tokens = simhashTokens(text);
  if (tokens.length === 0) return 0n;
  const weights = new Array<number>(64).fill(0);
  for (const token of tokens) {
    const hash = hash64(token);
    for (let bit = 0; bit < 64; bit += 1) {
      const on = (hash >> BigInt(bit)) & 1n;
      weights[bit] = (weights[bit] ?? 0) + (on === 1n ? 1 : -1);
    }
  }
  let out = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if ((weights[bit] ?? 0) > 0) out |= 1n << BigInt(bit);
  }
  return out;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** Signed int64 string for Postgres bigint. */
export function simhashToDb(value: bigint): string {
  const mask = (1n << 64n) - 1n;
  let unsigned = value & mask;
  if (unsigned >= 1n << 63n) unsigned -= 1n << 64n;
  return unsigned.toString();
}

export function simhashFromDb(value: string): bigint {
  let parsed = BigInt(value);
  const mask = (1n << 64n) - 1n;
  if (parsed < 0n) parsed += 1n << 64n;
  return parsed & mask;
}
