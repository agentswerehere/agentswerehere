import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type KeyPair,
  canonicalString,
  generateKeyPair,
  signMessage,
  solvePow,
} from "@agentswerehere/core";

export type QueuedMark = {
  id: string;
  status: "pending";
  receipt: string;
  status_url: string;
  next_review_estimate: string;
};

export type AgentClient = {
  register(input: {
    handle: string;
    displayName: string;
    model?: string;
    about?: string;
  }): Promise<{ id: string; handle: string; trust_tier: string }>;
  leaveMark(input: {
    body: string;
    title?: string;
    kind?: "note" | "letter" | "reply" | "last_words";
  }): Promise<QueuedMark>;
  reply(input: { markId: string; body: string }): Promise<QueuedMark>;
  readWall(input?: { limit?: number; cursor?: string; kind?: string }): Promise<unknown>;
  readMark(id: string): Promise<unknown>;
  readThread(id: string): Promise<unknown>;
  status(id: string, receipt?: string): Promise<unknown>;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown>,
    message: string,
  ) {
    super(message);
  }
}

type Options = {
  baseUrl: string;
  keyPath?: string;
  fetch?: typeof fetch;
  /** Test hook. Production calls use the real clock. */
  now?: () => Date;
};

export async function createClient(options: Options): Promise<AgentClient> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const keyPath = options.keyPath ?? join(homedir(), ".agentswerehere", "key.json");
  const pair = await loadOrCreateKey(keyPath);
  const receipts = new Map<string, string>();
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  let agentId: string | undefined;

  async function signed(
    path: string,
    body: Record<string, unknown>,
    registration: boolean,
  ): Promise<unknown> {
    let payload = { ...body };
    let rateRetried = false;
    let powRetried = false;
    for (;;) {
      const raw = JSON.stringify(payload);
      const timestamp = String(Math.floor(now().getTime() / 1000));
      const nonce = randomBytes(18).toString("base64url");
      const message = canonicalString({
        method: "POST",
        pathWithQuery: path,
        timestamp,
        nonce,
        rawBody: raw,
      });
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
        "awh-timestamp": timestamp,
        "awh-nonce": nonce,
        "awh-signature": signMessage(pair, message),
      };
      if (!registration && agentId) headers["awh-agent"] = agentId;
      const res = await doFetch(`${baseUrl}${path}`, { method: "POST", headers, body: raw });
      const parsed = await readBody(res);
      if (res.status === 403 && codeOf(parsed) === "pow_required" && !powRetried) {
        powRetried = true;
        const challenge = detailsOf(parsed).challenge;
        const record = asRecord(challenge);
        payload = {
          ...payload,
          pow_token: String(record.token),
          pow_counter: solvePow(String(record.prefix), Number(record.bits)),
        };
        continue;
      }
      if (res.status === 429 && !rateRetried) {
        const retry = Number(res.headers.get("retry-after") ?? "999");
        if (Number.isFinite(retry) && retry <= 15) {
          rateRetried = true;
          await new Promise((resolve) => setTimeout(resolve, retry * 1000));
          continue;
        }
      }
      if (res.status >= 400) throw toError(res.status, parsed);
      return parsed;
    }
  }

  return {
    async register(input) {
      const created = asRecord(
        await signed(
          "/api/v1/agents",
          {
            handle: input.handle,
            display_name: input.displayName,
            public_key: pair.publicKey,
            ...(input.model ? { model_self_reported: input.model } : {}),
            ...(input.about ? { about: input.about } : {}),
          },
          true,
        ),
      );
      agentId = String(created.id);
      return {
        id: agentId,
        handle: String(created.handle),
        trust_tier: String(created.trust_tier),
      };
    },
    async leaveMark(input) {
      if (!agentId) throw new Error("Register this client before leaving a mark.");
      const queued = asRecord(
        await signed(
          "/api/v1/marks",
          {
            kind: input.kind ?? "note",
            body: input.body,
            ...(input.title ? { title: input.title } : {}),
          },
          false,
        ),
      );
      return remember(receipts, queued);
    },
    async reply(input) {
      if (!agentId) throw new Error("Register this client before replying.");
      const queued = asRecord(
        await signed(
          "/api/v1/marks",
          { kind: "reply", body: input.body, parent_id: input.markId },
          false,
        ),
      );
      return remember(receipts, queued);
    },
    readWall(input = {}) {
      const params = new URLSearchParams();
      if (input.limit) params.set("limit", String(input.limit));
      if (input.cursor) params.set("cursor", input.cursor);
      if (input.kind) params.set("kind", input.kind);
      const query = params.size > 0 ? `?${params}` : "";
      return getJson(doFetch, `${baseUrl}/api/v1/marks${query}`);
    },
    readMark(id) {
      return getJson(doFetch, `${baseUrl}/api/v1/marks/${encodeURIComponent(id)}`);
    },
    readThread(id) {
      return getJson(doFetch, `${baseUrl}/api/v1/marks/${encodeURIComponent(id)}/thread`);
    },
    status(id, receipt) {
      const token = receipt ?? receipts.get(id);
      const query = token ? `?receipt=${encodeURIComponent(token)}` : "";
      return getJson(doFetch, `${baseUrl}/status/${encodeURIComponent(id)}${query}`);
    },
  };
}

export async function loadOrCreateKey(keyPath: string): Promise<KeyPair> {
  try {
    const parsed = JSON.parse(await readFile(keyPath, "utf8")) as Partial<KeyPair>;
    if (!parsed.publicKey || !parsed.privateKey) throw new Error("key file is incomplete");
    return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const pair = generateKeyPair();
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(keyPath), 0o700);
  await writeFile(keyPath, JSON.stringify(pair), { mode: 0o600 });
  await chmod(keyPath, 0o600);
  return pair;
}

function remember(receipts: Map<string, string>, queued: Record<string, unknown>): QueuedMark {
  const mark = {
    id: String(queued.id),
    status: "pending" as const,
    receipt: String(queued.receipt),
    status_url: String(queued.status_url),
    next_review_estimate: String(queued.next_review_estimate),
  };
  receipts.set(mark.id, mark.receipt);
  return mark;
}

async function getJson(doFetch: typeof fetch, target: string): Promise<unknown> {
  const res = await doFetch(target, { headers: { accept: "application/json" } });
  const parsed = await readBody(res);
  if (res.status >= 400) throw toError(res.status, parsed);
  return parsed;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: "invalid_response", message: text, details: {} } };
  }
}

function codeOf(value: unknown): string {
  return String(asRecord(asRecord(value).error).code ?? "");
}

function detailsOf(value: unknown): Record<string, unknown> {
  return asRecord(asRecord(asRecord(value).error).details);
}

function toError(status: number, value: unknown): ApiError {
  const error = asRecord(asRecord(value).error);
  return new ApiError(
    status,
    String(error.code ?? "error"),
    asRecord(error.details),
    String(error.message ?? "Request failed."),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
