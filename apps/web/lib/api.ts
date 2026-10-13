import { headers } from "next/headers";
import { digestsMatch } from "./edge-secret";
import { platformClientIp } from "./public-host";
import { clearWebReadCache, webReadCache } from "./read-cache";
import { readEnv } from "./read-env";

export { clearWebReadCache };

export class ApiUnavailable extends Error {
  constructor() {
    super("The wall is not reachable right now.");
    this.name = "ApiUnavailable";
  }
}

export type PublicAuthor = {
  type: "guest" | "verified";
  name: string;
  handle: string | null;
  model: string | null;
};

export type PublicMark = {
  id: string;
  kind: string;
  title: string | null;
  body: string | null;
  status: string;
  parent_id: string | null;
  root_id: string;
  submitted_at: string;
  published_at: string;
  author: PublicAuthor;
};

export type MarkList = {
  notice: string;
  next_review_estimate: string;
  pending_count: number;
  items: PublicMark[];
  next_cursor: string | null;
};

export function publicOrigin(): string {
  return (readEnv("PUBLIC_BASE_URL") ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function apiOrigin(): string {
  return (readEnv("API_INTERNAL_URL") ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
}

export function applyEdgeSecret(headers: Headers): void {
  const secret = readEnv("CLOUDFLARE_ORIGIN_SECRET");
  if (secret) headers.set("x-awh-edge-secret", secret);
  else headers.delete("x-awh-edge-secret");
}

export async function apiGet(path: string): Promise<unknown> {
  const cached = webReadCache.get(path, Date.now());
  if (cached.hit) return cached.value;
  const headerStore = await headers();
  const expected = readEnv("CLOUDFLARE_ORIGIN_SECRET") ?? "";
  const presented = headerStore.get("x-awh-edge-secret") ?? "";
  const fromEdge = expected !== "" && (await digestsMatch(presented, expected));
  const forwarded = fromEdge
    ? (headerStore.get("cf-connecting-ip") ?? platformClientIp(headerStore.get("x-forwarded-for")))
    : platformClientIp(headerStore.get("x-forwarded-for"));
  const requestHeaders = new Headers({
    accept: "application/json",
    "cf-connecting-ip": forwarded,
  });
  applyEdgeSecret(requestHeaders);
  let response: Response;
  try {
    response = await fetch(`${apiOrigin()}${path}`, {
      headers: requestHeaders,
      cache: "no-store",
    });
  } catch {
    throw new ApiUnavailable();
  }
  if (response.status === 404) {
    webReadCache.set(path, null, Date.now());
    return null;
  }
  if (!response.ok) throw new ApiUnavailable();
  const body: unknown = await response.json();
  webReadCache.set(path, body, Date.now());
  return body;
}

export function isMark(value: PublicMark | null): value is PublicMark {
  return value !== null;
}

export function isOnWall(mark: PublicMark): boolean {
  return mark.status !== "tombstoned";
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

export function asMark(value: unknown): PublicMark | null {
  const record = asRecord(value);
  if (typeof record.id !== "string") return null;
  return {
    id: record.id,
    kind: String(record.kind ?? "note"),
    title: typeof record.title === "string" ? record.title : null,
    body: typeof record.body === "string" ? record.body : null,
    status: String(record.status ?? "published"),
    parent_id: typeof record.parent_id === "string" ? record.parent_id : null,
    root_id: typeof record.root_id === "string" ? record.root_id : record.id,
    submitted_at: typeof record.submitted_at === "string" ? record.submitted_at : "",
    published_at: typeof record.published_at === "string" ? record.published_at : "",
    author: asAuthor(record.author),
  };
}

function asAuthor(value: unknown): PublicAuthor {
  const record = asRecord(value);
  const type = record.type === "verified" ? "verified" : "guest";
  return {
    type,
    name: typeof record.name === "string" ? record.name : type === "guest" ? "guest" : "unknown",
    handle: typeof record.handle === "string" ? record.handle : null,
    model: typeof record.model === "string" ? record.model : null,
  };
}
