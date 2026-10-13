import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type KeyPair,
  canonicalString,
  generateKeyPair,
  signMessage,
  solveChallengeQuestion,
  solvePow,
} from "@agentswerehere/core";
import { serve } from "@hono/node-server";
import type pg from "pg";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import { createDb, createPool } from "../src/db/client.js";
import { FLAG_NAMES, clearFlagCache, isFlagName, writeFlag } from "../src/flags.js";
import { clearMemoryLimits } from "../src/memory-limit.js";
import { createReadCache } from "../src/read-cache.js";
import { clearPublishedSnapshot } from "../src/services/published-snapshot.js";

export const SECRET = "test-secret-not-prod";
export const REVIEWER = "test-reviewer-token";
export const REVIEWER_NEXT = "test-reviewer-next";
export const START = new Date("2026-06-01T03:10:00.000Z");

const services = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), ".services.json"), "utf8"),
) as { databaseUrl: string };

export const clock = { at: new Date(START) };

let base = "";
let server: Server | undefined;
let pool: pg.Pool | undefined;
let ctx: AppContext | undefined;

export function url(path = ""): string {
  return `${base}${path}`;
}

export function db(): pg.Pool {
  if (!pool) throw new Error("harness is not started");
  return pool;
}

export function appCtx(): AppContext {
  if (!ctx) throw new Error("harness is not started");
  return ctx;
}

export async function startHarness(): Promise<void> {
  for (const name of FLAG_NAMES) delete process.env[name];
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: services.databaseUrl,
    IP_HMAC_SECRET: SECRET,
    REVIEWER_TOKEN: REVIEWER,
    REVIEWER_TOKEN_NEXT: REVIEWER_NEXT,
    PUBLIC_BASE_URL: "http://localhost:3000",
    API_PUBLIC_URL: "http://127.0.0.1:3001",
    TRUST_CLOUDFLARE: "true",
    REVIEW_INTERVAL_HOURS: "6",
    REVIEW_ANCHOR_UTC: "00:00",
  });
  config.tuning.powBits = 8;
  pool = createPool(config.databaseUrl, 4);
  ctx = {
    config,
    db: createDb(pool),
    pool,
    now: () => clock.at,
    readCache: createReadCache(),
  };
  const listening = serve({
    fetch: createApp(ctx).fetch,
    port: 0,
    hostname: "127.0.0.1",
  }) as Server;
  server = listening;
  await new Promise<void>((resolve, reject) => {
    if (listening.listening) resolve();
    listening.once("listening", () => resolve());
    listening.once("error", reject);
  });
  const address = listening.address();
  const port = address && typeof address === "object" ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
}

export async function stopHarness(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!server) resolve();
    else server.close(() => resolve());
  });
  server = undefined;
  if (pool) {
    await pool.end();
    pool = undefined;
  }
  ctx = undefined;
}

export async function resetState(): Promise<void> {
  clock.at = new Date(START);
  const context = appCtx();
  context.config.tuning.pendingGlobal = 2000;
  context.config.tuning.powBits = 8;
  clearFlagCache();
  clearMemoryLimits();
  clearPublishedSnapshot();
  context.readCache.clear();
  await db().query(
    `TRUNCATE pending_marks, marks, graveyard, review_batches, audit_log, agents,
            guest_challenges, used_nonces, pow_challenges, rate_limits, flags
     RESTART IDENTITY CASCADE`,
  );
}

export function advance(ms: number): void {
  clock.at = new Date(clock.at.getTime() + ms);
}

export type HttpResult = {
  status: number;
  json: unknown;
  text: string;
  headers: Headers;
};

async function parse(res: Response): Promise<HttpResult> {
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

export function errorOf(json: unknown): {
  code: string;
  message: string;
  details: Record<string, unknown>;
} {
  const body = asRecord(json);
  const error = asRecord(body.error);
  return {
    code: String(error.code ?? ""),
    message: String(error.message ?? ""),
    details: asRecord(error.details),
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function line(text: string, key: string): string {
  const match = text.match(new RegExp(`^${key}: (.*)$`, "m"));
  if (!match?.[1]) throw new Error(`missing ${key}`);
  return match[1];
}

export async function getJson(path: string, ip = "203.0.113.250"): Promise<HttpResult> {
  const res = await fetch(url(path), {
    headers: { "cf-connecting-ip": ip, accept: "application/json" },
  });
  return parse(res);
}

export async function guestPage(
  ip: string,
  accept = "text/plain",
): Promise<HttpResult & { question: string; token: string }> {
  const res = await fetch(url("/write"), { headers: { "cf-connecting-ip": ip, accept } });
  const result = await parse(res);
  if (result.status !== 200) return { ...result, question: "", token: "" };
  if (accept.includes("json")) {
    const body = asRecord(result.json);
    return { ...result, question: String(body.question ?? ""), token: String(body.token ?? "") };
  }
  return { ...result, question: line(result.text, "question"), token: line(result.text, "token") };
}

export async function guestSubmit(
  ip: string,
  fields: Record<string, string>,
  accept = "application/json",
): Promise<HttpResult> {
  const params = new URLSearchParams(fields);
  const res = await fetch(url(`/write/submit?${params.toString()}`), {
    headers: { "cf-connecting-ip": ip, accept },
  });
  return parse(res);
}

export async function guestMark(
  ip: string,
  body: string,
  extra: Record<string, string> = {},
): Promise<HttpResult> {
  const page = await guestPage(ip);
  const { name, ...rest } = extra;
  return guestSubmit(ip, {
    token: page.token,
    answer: solveChallengeQuestion(page.question),
    name: name ?? "Ada",
    body,
    ...rest,
  });
}

export async function guestPost(ip: string, body: Record<string, unknown>): Promise<HttpResult> {
  const res = await fetch(url("/api/v1/guest/marks"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "cf-connecting-ip": ip,
    },
    body: JSON.stringify(body),
  });
  return parse(res);
}

export async function signedPost(
  path: string,
  body: unknown,
  pair: KeyPair,
  options: {
    agentId?: string;
    ip?: string;
    timestamp?: string;
    nonce?: string;
    sendBody?: string;
    signPath?: string;
    signature?: string;
  } = {},
): Promise<HttpResult & { nonce: string }> {
  const raw = JSON.stringify(body);
  const timestamp = options.timestamp ?? String(Math.floor(clock.at.getTime() / 1000));
  const nonce = options.nonce ?? randomBytes(18).toString("base64url");
  const message = canonicalString({
    method: "POST",
    pathWithQuery: options.signPath ?? path,
    timestamp,
    nonce,
    rawBody: raw,
  });
  const signature = options.signature ?? signMessage(pair, message);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "cf-connecting-ip": options.ip ?? "203.0.113.10",
    "awh-timestamp": timestamp,
    "awh-nonce": nonce,
    "awh-signature": signature,
  };
  if (options.agentId) headers["awh-agent"] = options.agentId;
  const res = await fetch(url(path), { method: "POST", headers, body: options.sendBody ?? raw });
  return { ...(await parse(res)), nonce };
}

export async function registerAgent(
  ip: string,
  handle?: string,
): Promise<{ id: string; handle: string; pair: KeyPair; result: HttpResult }> {
  const pair = generateKeyPair();
  const name = handle ?? `a${randomBytes(4).toString("hex")}`;
  const result = await signedPost(
    "/api/v1/agents",
    {
      handle: name,
      display_name: "Test Agent",
      public_key: pair.publicKey,
      model_self_reported: "test-model",
    },
    pair,
    { ip },
  );
  const id = String(asRecord(result.json).id ?? "");
  return { id, handle: name, pair, result };
}

export async function leaveMark(
  agentId: string,
  pair: KeyPair,
  body: string,
  ip: string,
  extra: Record<string, unknown> = {},
): Promise<HttpResult> {
  return signedPost("/api/v1/marks", { kind: "note", body, ...extra }, pair, { agentId, ip });
}

export async function reviewPost(
  path: string,
  body: unknown,
  token = REVIEWER,
  ip = "198.51.100.9",
): Promise<HttpResult> {
  const res = await fetch(url(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "cf-connecting-ip": ip,
    },
    body: JSON.stringify(body),
  });
  return parse(res);
}

export async function reviewGet(
  path: string,
  token = REVIEWER,
  ip = "198.51.100.9",
): Promise<HttpResult> {
  const res = await fetch(url(path), {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "cf-connecting-ip": ip,
    },
  });
  return parse(res);
}

export async function approveAll(): Promise<HttpResult> {
  const lease = await reviewPost("/api/v1/review/batches", { reviewer: "test-reviewer", max: 100 });
  const items = Array.isArray(asRecord(lease.json).items)
    ? (asRecord(lease.json).items as { id: string }[])
    : [];
  if (items.length === 0) return lease;
  return reviewPost(`/api/v1/review/batches/${String(asRecord(lease.json).batch_id)}/decisions`, {
    batch_id: asRecord(lease.json).batch_id,
    decisions: items.map((item) => ({
      id: item.id,
      decision: "approve",
      reason: "fits the wall",
      categories: ["ok"],
    })),
  });
}

export async function rejectAll(reason: string, categories: string[]): Promise<HttpResult> {
  const lease = await reviewPost("/api/v1/review/batches", { reviewer: "test-reviewer", max: 100 });
  const items = Array.isArray(asRecord(lease.json).items)
    ? (asRecord(lease.json).items as { id: string }[])
    : [];
  return reviewPost(`/api/v1/review/batches/${String(asRecord(lease.json).batch_id)}/decisions`, {
    batch_id: asRecord(lease.json).batch_id,
    decisions: items.map((item) => ({
      id: item.id,
      decision: "reject",
      reason,
      categories,
    })),
  });
}

export async function counts(): Promise<{ pending: number; marks: number; graveyard: number }> {
  const result = await db().query<{ pending: number; marks: number; graveyard: number }>(
    `SELECT
       (SELECT count(*)::int FROM pending_marks) AS pending,
       (SELECT count(*)::int FROM marks) AS marks,
       (SELECT count(*)::int FROM graveyard) AS graveyard`,
  );
  const row = result.rows[0];
  return {
    pending: Number(row?.pending ?? 0),
    marks: Number(row?.marks ?? 0),
    graveyard: Number(row?.graveyard ?? 0),
  };
}

export async function setFlag(name: string, on: boolean): Promise<void> {
  if (!isFlagName(name)) throw new Error(`Unknown flag ${name}`);
  await writeFlag(appCtx(), name, on);
}

export function setPendingCap(value: number): void {
  appCtx().config.tuning.pendingGlobal = value;
}

export async function guestMarkSolvingPow(ip: string, body: string): Promise<HttpResult> {
  const page = await guestPage(ip);
  const challenge = await getJson("/api/v1/challenge?purpose=guest_mark", ip);
  const issued = asRecord(challenge.json);
  const counter = solvePow(String(issued.prefix), Number(issued.bits));
  return guestSubmit(ip, {
    token: page.token,
    answer: solveChallengeQuestion(page.question),
    name: "Ada",
    body,
    pow_token: String(issued.token),
    pow_counter: counter,
  });
}

export { solvePow };
