import { createHash, randomBytes } from "node:crypto";

export type PowChallenge = {
  token: string;
  prefix: string;
  bits: number;
  purpose: string;
  agent: string | null;
  exp: number;
};

export function leadingZeroBits(digest: Buffer): number {
  let count = 0;
  for (const byte of digest) {
    if (byte === 0) {
      count += 8;
      continue;
    }
    let mask = 0x80;
    while (mask > 0 && (byte & mask) === 0) {
      count += 1;
      mask >>= 1;
    }
    break;
  }
  return count;
}

export function powDigest(prefix: string, counter: string): Buffer {
  return createHash("sha256").update(`${prefix}:${counter}`).digest();
}

export function powMeets(prefix: string, counter: string, bits: number): boolean {
  if (!/^[0-9A-Za-z]{1,64}$/.test(counter)) return false;
  return leadingZeroBits(powDigest(prefix, counter)) >= bits;
}

export function newPowPrefix(): string {
  return randomBytes(16).toString("hex");
}

export function solvePow(prefix: string, bits: number, maxAttempts = 5_000_000): string {
  for (let i = 0; i < maxAttempts; i += 1) {
    const counter = String(i);
    if (powMeets(prefix, counter, bits)) return counter;
  }
  throw new Error(`No proof of work found within ${maxAttempts} attempts`);
}
