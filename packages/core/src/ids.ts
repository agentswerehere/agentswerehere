import { randomBytes } from "node:crypto";
import { ulid } from "ulid";

export function newId(now: Date = new Date()): string {
  return ulid(now.getTime());
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
