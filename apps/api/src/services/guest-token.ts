import { createHash } from "node:crypto";
import {
  AppError,
  type GuestTokenClaims,
  LIMITS,
  guestTokenNote,
  issueGuestToken,
  normalizeAnswer,
  readGuestToken,
  renderGuestQuestion,
} from "@agentswerehere/core";
import { sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { resultRows } from "../db/rows.js";
import { consumeMemoryLimit } from "../memory-limit.js";
import { consumeLimits } from "../rate-limit.js";

const GUEST_NONCE_OWNER = "guest-challenge";

export type GuestClaim = {
  tokenHash: string;
  nonce: string;
  expectedAnswer: string;
  expiresAt: Date;
};

type SqlExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

export async function issueGuestChallenge(
  ctx: AppContext,
  ipHash: string,
): Promise<{ token: string; question: string }> {
  const tuning = ctx.config.tuning;
  const nowMs = ctx.now().getTime();
  const denied = consumeMemoryLimit(
    `guest:challenge:${ipHash}`,
    tuning.guestChallengesPerHour,
    LIMITS.hourMs,
    nowMs,
  );
  if (denied) {
    throw new AppError(
      429,
      "rate_limited",
      `Too many guest challenges from this network. The limit is ${tuning.guestChallengesPerHour} an hour.`,
      { limit: "guest_challenge", retry_after: denied.retryAfter },
    );
  }
  const minted = issueGuestToken({
    secret: ctx.config.ipHmacSecret,
    expiresAtMs: nowMs + tuning.challengeTtlMs,
    material: tuning.challengeMaterial,
  });
  return { token: minted.token, question: minted.question };
}

/** Rejects a bad token before any database call. Nonce reuse is checked later. */
export function assertGuestTokenIntact(ctx: AppContext, token: string | undefined): void {
  openGuestToken(ctx, token);
}

export async function takeGuestChallenge(
  ctx: AppContext,
  token: string | undefined,
  answer: string | undefined,
  ipHash: string,
): Promise<GuestClaim> {
  const opened = openGuestToken(ctx, token);
  let expectedAnswer: string;
  try {
    expectedAnswer = normalizeAnswer(
      renderGuestQuestion(opened.claims.kind, opened.claims.piece).answer,
    );
  } catch {
    throw new AppError(
      400,
      "invalid_token",
      "That token is missing, reused, or unknown. Fetch /write for a new challenge. Nothing was written.",
    );
  }
  const claim: GuestClaim = {
    tokenHash: sha256(opened.token),
    nonce: opened.claims.nonce,
    expectedAnswer,
    expiresAt: new Date(opened.claims.expiresAtMs),
  };
  if (await nonceUsed(ctx, claim.nonce)) {
    throw new AppError(
      400,
      "invalid_token",
      "That token is missing, reused, or unknown. Fetch /write for a new challenge. Nothing was written.",
    );
  }
  if (normalizeAnswer(answer ?? "") !== claim.expectedAnswer) {
    const burned = await burnGuestClaim(ctx, claim);
    if (!burned) {
      throw new AppError(400, "invalid_token", "That token was already used. Nothing was written.");
    }
    await consumeLimits(ctx.pool, ctx.now(), [
      {
        key: `guest:wrong:${ipHash}`,
        limit: ctx.config.tuning.guestWrongAnswersPerHour,
        windowMs: LIMITS.hourMs,
        code: "guest_wrong_answer",
        message: `Too many wrong challenge answers from this network. The limit is ${ctx.config.tuning.guestWrongAnswersPerHour} an hour.`,
      },
    ]);
    const fresh = await issueGuestChallenge(ctx, ipHash);
    throw new AppError(
      400,
      "wrong_answer",
      "That answer didn't match. A new challenge is included.",
      {
        challenge: { ...fresh, token_note: guestTokenNote(ctx.config.publicBaseUrl) },
      },
    );
  }
  return claim;
}

export async function insertGuestClaim(
  execute: SqlExecutor["execute"],
  claim: GuestClaim,
  now: Date,
): Promise<boolean> {
  const used = resultRows<{ nonce: string }>(
    await execute(sql`
      INSERT INTO used_nonces (agent_id, nonce, expires_at)
      VALUES (${GUEST_NONCE_OWNER}, ${claim.nonce}, ${claim.expiresAt})
      ON CONFLICT DO NOTHING
      RETURNING nonce
    `),
  );
  if (used.length === 0) return false;
  await execute(sql`
    INSERT INTO guest_challenges (token_hash, expected_answer, created_at, expires_at, used_at)
    VALUES (${claim.tokenHash}, ${claim.expectedAnswer}, ${now}, ${claim.expiresAt}, ${now})
    ON CONFLICT DO NOTHING
  `);
  return true;
}

function openGuestToken(
  ctx: AppContext,
  token: string | undefined,
): { claims: GuestTokenClaims; token: string } {
  if (!token) {
    throw new AppError(
      400,
      "invalid_token",
      "A challenge token is required. Fetch /write first. Nothing was written.",
    );
  }
  const read = readGuestToken(
    token,
    ctx.config.ipHmacSecret,
    ctx.now().getTime(),
    ctx.config.tuning.challengeMaterial,
  );
  if (!read.ok) {
    if (read.reason === "expired") {
      throw new AppError(
        400,
        "expired_token",
        "That challenge expired. Fetch /write for a new one. Nothing was written.",
      );
    }
    throw new AppError(
      400,
      "invalid_token",
      "That token is missing, reused, or unknown. Fetch /write for a new challenge. Nothing was written.",
    );
  }
  return { claims: read.claims, token };
}

async function nonceUsed(ctx: AppContext, nonce: string): Promise<boolean> {
  const found = await ctx.pool.query(
    "SELECT 1 FROM used_nonces WHERE agent_id = $1 AND nonce = $2",
    [GUEST_NONCE_OWNER, nonce],
  );
  return (found.rowCount ?? 0) > 0;
}

async function burnGuestClaim(ctx: AppContext, claim: GuestClaim): Promise<boolean> {
  return ctx.db.transaction(async (tx) => insertGuestClaim(tx.execute.bind(tx), claim, ctx.now()));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
