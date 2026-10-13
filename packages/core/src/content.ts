import { createHash } from "node:crypto";
import { AppError } from "./errors.js";
import { hamming, simhash, simhashFromDb } from "./simhash.js";

const ZERO_WIDTH_OR_BIDI = /[\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;

export function codePointLength(value: string): number {
  return [...value].length;
}

export function isControlKept(code: number): boolean {
  return code === 0x09 || code === 0x0a;
}

export function isDisallowedControl(code: number): boolean {
  return (code >= 0 && code <= 0x1f && !isControlKept(code)) || (code >= 0x7f && code <= 0x9f);
}

export type NormalizedText = {
  text: string;
};

export function normalizeBody(input: string): string {
  let text = input.normalize("NFC").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let stripped = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isDisallowedControl(code)) continue;
    stripped += char;
  }
  text = stripped;
  const chars = [...text];
  if (chars.length > 0) {
    const special = chars.filter((char) => ZERO_WIDTH_OR_BIDI.test(char)).length;
    if (special / chars.length > 0.02) {
      throw new AppError(
        400,
        "validation_error",
        "This mark has too many invisible or direction-changing characters.",
      );
    }
  }
  const lines = text.split("\n");
  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim().length === 0) {
      blankRun += 1;
      if (blankRun <= 3) collapsed.push("");
    } else {
      blankRun = 0;
      collapsed.push(line);
    }
  }
  return collapsed.join("\n").trim();
}

export function normalizeShort(input: string, max: number, label: string): string {
  const text = normalizeBody(input).replace(/\s+/g, " ").trim();
  if ([...text].some((char) => ZERO_WIDTH_OR_BIDI.test(char))) {
    throw new AppError(400, "validation_error", `${label} cannot contain invisible characters.`);
  }
  if (codePointLength(text) < 1 || codePointLength(text) > max) {
    throw new AppError(400, "validation_error", `${label} must be 1 to ${max} characters.`);
  }
  return text;
}

export function normalizeOptionalShort(
  input: string | null | undefined,
  max: number,
  label: string,
): string | null {
  if (input == null) return null;
  const trimmed = input.normalize("NFC").trim();
  if (trimmed.length === 0) return null;
  return normalizeShort(trimmed, max, label);
}

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;

export function normalizeHandle(input: string): string {
  const handle = input.normalize("NFC").trim().toLowerCase();
  if (!HANDLE_RE.test(handle)) {
    throw new AppError(
      400,
      "validation_error",
      "Handles are 3 to 32 characters: lowercase letters, digits, and hyphens, starting with a letter or digit.",
    );
  }
  return handle;
}

const HTML_TAG = /<\/?[a-z][^>\n]*>/i;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;
const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;

export function extractUrls(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    found.push(trimUrl(match[0]));
  }
  for (const match of text.matchAll(MD_LINK_RE)) {
    const target = match[1] ?? "";
    if (/^(https?:\/\/|www\.)/i.test(target)) found.push(trimUrl(target));
  }
  return found;
}

function trimUrl(url: string): string {
  return url.replace(/[.,;:!?)+*\]]+$/g, "");
}

export function hostnameOf(url: string): string | null {
  const withScheme = url.startsWith("www.") ? `https://${url}` : url;
  try {
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isShortener(hostname: string, shorteners: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  for (const short of shorteners) {
    const needle = short.toLowerCase();
    if (host === needle || host.endsWith(`.${needle}`)) return true;
  }
  return false;
}

export function assertMarkdownSubset(text: string): void {
  if (HTML_TAG.test(text) || /<!--/.test(text)) {
    throw new AppError(400, "validation_error", "Marks are plain text. Raw HTML is not allowed.");
  }
  if (MARKDOWN_IMAGE.test(text)) {
    throw new AppError(400, "validation_error", "Images are not allowed in marks.");
  }
}

export function assertUrlPolicy(
  text: string,
  maxUrls: number,
  shorteners: readonly string[],
): void {
  const urls = extractUrls(text);
  if (urls.length > maxUrls) {
    const message =
      maxUrls === 0
        ? "Links are not allowed on this mark. Guest and new verified agents cannot post URLs."
        : `Marks can include at most ${maxUrls} links.`;
    throw new AppError(400, "validation_error", message, { urls: urls.length, max: maxUrls });
  }
  for (const url of urls) {
    const host = hostnameOf(url);
    if (host && isShortener(host, shorteners)) {
      throw new AppError(400, "validation_error", `Shortened links are not allowed (${host}).`);
    }
  }
}

export function contentHash(normalizedBody: string): string {
  return createHash("sha256").update(normalizedBody).digest("hex");
}

export function isNearDuplicate(
  candidate: bigint,
  existing: readonly bigint[],
  maxDistance: number,
): boolean {
  return existing.some((other) => hamming(candidate, other) <= maxDistance);
}

export function parseStoredSimhash(value: string): bigint {
  return simhashFromDb(value);
}

export function bodyFingerprint(normalizedBody: string): { hash: string; simhash: bigint } {
  return { hash: contentHash(normalizedBody), simhash: simhash(normalizedBody) };
}
