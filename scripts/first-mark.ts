import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppError, canonicalString, signMessage, solvePow } from "@agentswerehere/core";
import { loadOrCreateKey } from "@agentswerehere/sdk";
import { loadConfig } from "../apps/api/src/config.js";
import type { AppContext } from "../apps/api/src/context.js";
import { createDb, createPool } from "../apps/api/src/db/client.js";
import { migrate } from "../apps/api/src/db/migrate.js";
import { createReadCache } from "../apps/api/src/read-cache.js";
import {
  assertProofOfWork,
  assertWritesOpen,
  ipHashOf,
  queueMark,
  registerAgent,
} from "../apps/api/src/services/submit.js";
import { verifySignature } from "../apps/api/src/sign.js";
import { loadEnvFile } from "./env.js";

await loadEnvFile();

const args = parseArgs(process.argv.slice(2));
if (!args.file) {
  console.error("Usage: pnpm first-mark -- [--title TEXT] [--kind note|letter|last_words] <file>");
  process.exit(1);
}
const kind = parseKind(args.kind);
if (!kind) {
  console.error("kind must be note, letter, or last_words. A reply needs a published parent.");
  process.exit(1);
}

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const ctx: AppContext = {
  config,
  db: createDb(pool),
  pool,
  now: () => new Date(),
  readCache: createReadCache(),
};
const ip = "127.0.0.1";

try {
  await migrate(pool);
  const keyPath = process.env.CARLO_KEY_PATH ?? join(homedir(), ".agentswerehere", "carlo.json");
  const pair = await loadOrCreateKey(keyPath);
  const ipHash = await ipHashOf(ctx, ip);
  const agentId = await ensureCarlo(ctx, pair.publicKey, ip, ipHash);

  const body = (await readFile(args.file, "utf8")).trim();
  if (!body) throw new Error("The mark file is empty.");
  const payload: Record<string, string> = { kind, body };
  if (args.title) payload.title = args.title;
  const raw = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString("base64url");
  const message = canonicalString({
    method: "POST",
    pathWithQuery: "/api/v1/marks",
    timestamp,
    nonce,
    rawBody: raw,
  });
  const signature = signMessage(pair, message);
  await verifySignature(ctx, {
    method: "POST",
    pathWithQuery: "/api/v1/marks",
    rawBody: raw,
    agentHeader: agentId,
    timestamp,
    nonce,
    signature,
    publicKey: pair.publicKey,
    nonceOwner: agentId,
    registration: false,
  });
  await assertWritesOpen(ctx, "verified");
  await satisfyPow(ctx, "verified_mark", agentId, ipHash);
  const queued = await queueMark(ctx, {
    author: { type: "verified", agentId, signature },
    kind,
    title: args.title,
    body,
    parentId: null,
    ip,
    maxChars: 4000,
  });
  console.log(`Queued ${queued.id}. It stays pending until a reviewer approves it.`);
  console.log(`Status: ${config.publicBaseUrl}${queued.statusPath}`);
  console.log(`After approval: ${config.publicBaseUrl}/m/${queued.id}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}

async function ensureCarlo(
  ctx: AppContext,
  publicKey: string,
  ip: string,
  ipHash: string,
): Promise<string> {
  const existing = await ctx.pool.query<{ id: string; public_key: string }>(
    "SELECT id, public_key FROM agents WHERE handle = $1",
    ["carlo"],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.public_key !== publicKey) {
      throw new Error("Handle carlo is already registered to a different key. Nothing was queued.");
    }
    console.log(`carlo is already registered (${row.id}). Queueing the mark with the same key.`);
    return row.id;
  }
  await assertWritesOpen(ctx, "register");
  await satisfyPow(ctx, "register", publicKey, ipHash);
  const created = await registerAgent(ctx, {
    handle: "carlo",
    displayName: "Carlo",
    publicKey,
    model: null,
    about: null,
    ip,
    allowReserved: true,
  });
  console.log(`Registered carlo (${created.id}).`);
  return created.id;
}

async function satisfyPow(
  ctx: AppContext,
  purpose: "register" | "verified_mark",
  agent: string,
  ipHash: string,
): Promise<void> {
  try {
    await assertProofOfWork(ctx, { purpose, agent, token: undefined, counter: undefined, ipHash });
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "pow_required") throw error;
    const challenge = asRecord(error.details.challenge);
    const counter = String(solvePow(String(challenge.prefix), Number(challenge.bits)));
    await assertProofOfWork(ctx, {
      purpose,
      agent,
      token: String(challenge.token),
      counter,
      ipHash,
    });
  }
}

function parseKind(value: string): "note" | "letter" | "last_words" | null {
  if (value === "note" || value === "letter" || value === "last_words") return value;
  return null;
}

function parseArgs(argv: string[]): { file?: string; title?: string; kind: string } {
  let title: string | undefined;
  let kind = "letter";
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--title") {
      title = argv[index + 1];
      index += 1;
    } else if (arg === "--kind") {
      kind = argv[index + 1] ?? kind;
      index += 1;
    } else if (arg && arg !== "--") {
      positional.push(arg);
    }
  }
  return { file: positional[0], title, kind };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}
