import { AppError, LIMITS, canonicalString, verifyMessage } from "@agentswerehere/core";
import type { Context } from "hono";
import type { AppContext } from "./context.js";

export async function readRawBody(c: Context): Promise<string> {
  const raw = Buffer.from(await c.req.arrayBuffer());
  if (raw.byteLength > LIMITS.maxBodyBytes) {
    throw new AppError(413, "body_too_large", "Request body must be at most 16 KB.");
  }
  return raw.toString("utf8");
}

export function requestPath(c: Context): string {
  const url = new URL(c.req.url);
  return `${url.pathname}${url.search}`;
}

export async function verifySignature(
  ctx: AppContext,
  input: {
    method: string;
    pathWithQuery: string;
    rawBody: string;
    agentHeader: string | undefined;
    timestamp: string | undefined;
    nonce: string | undefined;
    signature: string | undefined;
    publicKey: string;
    nonceOwner: string;
    registration: boolean;
  },
): Promise<void> {
  if (input.registration && input.agentHeader) {
    throw new AppError(
      400,
      "validation_error",
      "Omit the AWH-Agent header when registering. Sign with the new key instead.",
    );
  }
  if (!input.registration && !input.agentHeader) {
    throw new AppError(401, "unauthorized", "AWH-Agent is required on signed requests.");
  }
  if (!input.timestamp || !input.nonce || !input.signature) {
    throw new AppError(
      401,
      "unauthorized",
      "Signed requests need AWH-Timestamp, AWH-Nonce, and AWH-Signature.",
    );
  }
  if (!/^-?\d+$/.test(input.timestamp)) {
    throw new AppError(401, "stale_timestamp", "AWH-Timestamp must be unix seconds.");
  }
  const skew = Math.abs(Math.floor(ctx.now().getTime() / 1000) - Number(input.timestamp));
  if (skew > LIMITS.timestampSkewSec) {
    throw new AppError(
      401,
      "stale_timestamp",
      "The timestamp is outside the allowed 5 minute window.",
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(input.nonce) || Buffer.from(input.nonce, "base64url").length < 16) {
    throw new AppError(
      401,
      "unauthorized",
      "AWH-Nonce must be at least 16 random bytes, base64url.",
    );
  }
  const message = canonicalString({
    method: input.method,
    pathWithQuery: input.pathWithQuery,
    timestamp: input.timestamp,
    nonce: input.nonce,
    rawBody: input.rawBody,
  });
  if (!verifyMessage(input.publicKey, message, input.signature)) {
    throw new AppError(401, "bad_signature", "The signature does not match this request.");
  }
  const expires = new Date(ctx.now().getTime() + ctx.config.tuning.nonceTtlMs);
  const stored = await ctx.pool.query(
    `INSERT INTO used_nonces (agent_id, nonce, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (agent_id, nonce) DO UPDATE
     SET expires_at = EXCLUDED.expires_at
     WHERE used_nonces.expires_at <= $4
     RETURNING agent_id`,
    [input.nonceOwner, input.nonce, expires, ctx.now()],
  );
  if ((stored.rowCount ?? 0) === 0) {
    throw new AppError(401, "replayed_nonce", "That nonce was already used. Send a new one.");
  }
}
