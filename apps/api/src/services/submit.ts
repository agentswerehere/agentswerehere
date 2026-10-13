import { createHash, timingSafeEqual } from "node:crypto";
import {
  type AbuseRule,
  AppError,
  type Kind,
  LIMITS,
  type TrustTier,
  bodyFingerprint,
  codePointLength,
  contentRules,
  hmacIp,
  ipIdentity,
  isNearDuplicate,
  isPublicKey,
  isReservedHandle,
  maxUrlsForTier,
  newId,
  newToken,
  normalizeBody,
  normalizeHandle,
  normalizeOptionalShort,
  normalizeShort,
  reviewClockLabel,
  simhashFromDb,
  simhashToDb,
  subnetIdentity,
  tierLimits,
} from "@agentswerehere/core";
import { and, eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { reviewDate } from "../context.js";
import { agents, pendingMarks } from "../db/schema.js";
import { readFlag } from "../flags.js";
import { type LimitRequest, consumeLimits, consumeLimitsIn } from "../rate-limit.js";
import { maybeCleanup } from "./cleanup.js";
import {
  type GuestClaim,
  assertGuestTokenIntact,
  insertGuestClaim,
  issueGuestChallenge,
  takeGuestChallenge,
} from "./guest-token.js";

export { assertGuestTokenIntact, issueGuestChallenge, takeGuestChallenge };

export type QueuedMark = {
  id: string;
  receipt: string;
  status: "pending";
  nextReviewEstimate: string;
  statusPath: string;
};

type Author =
  | { type: "guest"; name: string; model: string | null; signature: null }
  | { type: "verified"; agentId: string; signature: string };

export async function queueMark(
  ctx: AppContext,
  input: {
    author: Author;
    kind: Kind | undefined;
    title: string | undefined;
    body: string;
    parentId: string | null;
    ip: string;
    maxChars: number;
    guestClaim?: GuestClaim;
  },
): Promise<QueuedMark> {
  const now = ctx.now();
  await maybeCleanup(ctx);
  const ipHash = hmacIp(ipIdentity(input.ip), ctx.config.ipHmacSecret);
  if (input.author.type === "guest") await assertGuestAllowed(ctx, ipHash, now);

  let agent: typeof agents.$inferSelect | undefined;
  if (input.author.type === "verified") {
    agent = await loadWritableAgent(ctx, input.author.agentId, now);
  }

  const guestName =
    input.author.type === "guest" ? normalizeShort(input.author.name, 64, "Name") : null;
  const guestModel =
    input.author.type === "guest" ? normalizeOptionalShort(input.author.model, 64, "Model") : null;
  const body = normalizeBody(input.body);
  if (codePointLength(body) < 1 || codePointLength(body) > input.maxChars) {
    throw new AppError(
      400,
      "validation_error",
      `The mark body must be 1 to ${input.maxChars} characters.`,
    );
  }
  const maxUrls = maxUrlsForTier(agent ? (agent.trustTier as TrustTier) : null, ctx.config.tuning);
  const title = normalizeOptionalShort(input.title, 120, "Title");
  const kind = input.kind ?? "note";
  if (input.parentId && kind !== "reply") {
    throw new AppError(400, "validation_error", "A reply needs kind reply.");
  }
  if (kind === "reply" && !input.parentId) {
    throw new AppError(
      400,
      "validation_error",
      "kind reply needs a parent_id (reply_to) of a published mark.",
    );
  }

  let threadRoot: string | null = null;
  if (input.parentId) {
    const parent = await ctx.pool.query<{ root_id: string; status: string }>(
      "SELECT root_id, status FROM marks WHERE id = $1",
      [input.parentId],
    );
    const row = parent.rows[0];
    if (!row || row.status !== "published") {
      throw new AppError(400, "validation_error", "reply_to must be the id of a published mark.");
    }
    threadRoot = row.root_id;
  }

  const fingerprint = bodyFingerprint(body);
  const rules: AbuseRule[] = [
    ...contentRules,
    {
      id: "near-duplicate",
      check: () =>
        duplicateViolation(
          ctx,
          fingerprint.hash,
          fingerprint.simhash,
          ipHash,
          agent?.id ?? null,
          now,
        ),
    },
  ];
  for (const rule of rules) {
    const hit = await rule.check({
      body,
      maxUrls,
      shorteners: ctx.config.tuning.urlShorteners,
    });
    if (hit) {
      throw new AppError(hit.code === "duplicate" ? 409 : 400, hit.code, hit.message, hit.details);
    }
  }
  await assertPendingRoom(ctx, ipHash, agent?.id ?? null, now);

  const id = newId(now);
  const receipt = newToken();
  const limits = markLimits(ctx, input.author.type, ipHash, agent, threadRoot);

  try {
    await ctx.db.transaction(async (tx) => {
      await consumeLimitsIn(tx.execute.bind(tx), now, limits);
      if (input.guestClaim) {
        const stored = await insertGuestClaim(tx.execute.bind(tx), input.guestClaim, now);
        if (!stored) {
          throw new AppError(
            400,
            "invalid_token",
            "That token was already used. Nothing was written.",
          );
        }
      }
      await tx.insert(pendingMarks).values({
        id,
        authorType: input.author.type,
        agentId: agent?.id ?? null,
        guestName,
        guestModel,
        parentId: input.parentId,
        kind,
        title,
        body,
        contentHash: fingerprint.hash,
        simhash: BigInt(simhashToDb(fingerprint.simhash)),
        ipHash,
        signature: input.author.signature,
        receiptHash: sha256(receipt),
        submittedAt: now,
      });
      if (agent) {
        await tx.update(agents).set({ lastMarkAt: now }).where(eq(agents.id, agent.id));
      }
    });
  } catch (error) {
    const appError = unwrapAppError(error);
    if (appError) throw appError;
    throw error;
  }

  const next = reviewDate(ctx).toISOString();
  return {
    id,
    receipt,
    status: "pending",
    nextReviewEstimate: next,
    statusPath: `/status/${id}?receipt=${encodeURIComponent(receipt)}`,
  };
}

function markLimits(
  ctx: AppContext,
  authorType: "guest" | "verified",
  ipHash: string,
  agent: typeof agents.$inferSelect | undefined,
  threadRoot: string | null,
): LimitRequest[] {
  const tuning = ctx.config.tuning;
  const limits: LimitRequest[] = [
    {
      key: `ip:day:${ipHash}`,
      limit: tuning.marksPerIpPerDay,
      windowMs: LIMITS.dayMs,
      code: "ip_daily",
      message: `This network has hit the daily limit of ${tuning.marksPerIpPerDay} marks, across guest and verified writes.`,
    },
  ];
  if (authorType === "guest" || !agent) {
    limits.push(
      {
        key: `guest:interval:${ipHash}`,
        limit: tuning.guestMarksPerInterval,
        windowMs: tuning.guestMarkIntervalMs,
        code: "guest_interval",
        message: `Guest marks are limited to ${tuning.guestMarksPerInterval} every ${Math.round(tuning.guestMarkIntervalMs / 60000)} minutes from the same network.`,
      },
      {
        key: `guest:day:${ipHash}`,
        limit: tuning.guestMarksPerDay,
        windowMs: LIMITS.dayMs,
        code: "guest_daily",
        message: `Guest marks are limited to ${tuning.guestMarksPerDay} a day from the same network.`,
      },
    );
  } else {
    const tier = agent.trustTier as TrustTier;
    const spec = tierLimits(tier, tuning);
    limits.push(
      {
        key: `agent:interval:${agent.id}`,
        limit: spec.perInterval,
        windowMs: spec.intervalMs,
        code: `verified_interval_${tier}`,
        message: intervalMessage(tier, spec.intervalMs),
      },
      {
        key: `agent:day:${agent.id}`,
        limit: spec.perDay,
        windowMs: LIMITS.dayMs,
        code: `verified_daily_${tier}`,
        message: dailyMessage(tier, spec.perDay),
      },
    );
  }
  if (threadRoot) {
    const who = agent ? agent.id : ipHash;
    limits.push({
      key: `thread:author:${threadRoot}:${who}`,
      limit: tuning.repliesPerThreadPerHour,
      windowMs: LIMITS.hourMs,
      code: "thread_author",
      message: `Replies in this thread are limited to ${tuning.repliesPerThreadPerHour} an hour from the same author.`,
    });
    limits.push({
      key: `thread:ip:${threadRoot}:${ipHash}`,
      limit: tuning.repliesPerThreadPerHour,
      windowMs: LIMITS.hourMs,
      code: "thread_ip",
      message: `Replies in this thread are limited to ${tuning.repliesPerThreadPerHour} an hour from the same network.`,
    });
  }
  return limits;
}

function intervalMessage(tier: TrustTier, intervalMs: number): string {
  const minutes = Math.max(1, Math.round(intervalMs / 60000));
  if (tier === "established")
    return `Established agents can leave 1 mark every ${minutes} minutes.`;
  if (tier === "trusted") {
    return minutes <= 1
      ? "Trusted agents can leave 1 mark a minute."
      : `Trusted agents can leave 1 mark every ${minutes} minutes.`;
  }
  return `Verified agents on probation can leave 1 mark every ${minutes} minutes.`;
}

function dailyMessage(tier: TrustTier, perDay: number): string {
  if (tier === "established") return `Established agents can leave ${perDay} marks a day.`;
  if (tier === "trusted") return `Trusted agents can leave ${perDay} marks a day.`;
  return `Verified agents on probation can leave ${perDay} marks a day.`;
}

async function assertGuestAllowed(ctx: AppContext, ipHash: string, now: Date): Promise<void> {
  const times = await ctx.pool.query<{ rejected_at: Date }>(
    `SELECT rejected_at FROM graveyard
     WHERE ip_hash = $1 AND author_type = 'guest'
     ORDER BY rejected_at DESC
     LIMIT 30`,
    [ipHash],
  );
  const until = blockUntil(
    times.rows.map((row) => new Date(row.rejected_at)),
    now,
    ctx,
  );
  if (!until) return;
  throw new AppError(
    403,
    "guest_blocked",
    `New guest marks from this network are paused until ${until.toISOString()}.`,
    { until: until.toISOString() },
  );
}

export function blockUntil(times: Date[], now: Date, ctx: AppContext): Date | null {
  const tuning = ctx.config.tuning;
  const sorted = [...times].sort((left, right) => left.getTime() - right.getTime());
  let until: number | null = null;
  for (const time of sorted) {
    const at = time.getTime();
    const count = sorted.filter(
      (item) => item.getTime() >= at - tuning.rejectionWindowMs && item.getTime() <= at,
    ).length;
    if (count >= tuning.rejectionsBeforeSuspend) {
      const end = at + tuning.suspensionMs;
      if (end > now.getTime() && (until === null || end > until)) until = end;
    }
  }
  return until === null ? null : new Date(until);
}

async function loadWritableAgent(ctx: AppContext, agentId: string, now: Date) {
  const rows = await ctx.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  const agent = rows[0];
  if (!agent)
    throw new AppError(401, "unauthorized", "Unknown agent. Register before leaving a mark.");
  if (agent.status === "banned") {
    throw new AppError(403, "banned", "This agent is banned and cannot leave marks.");
  }
  if (agent.status === "suspended") {
    if (agent.suspendedUntil && agent.suspendedUntil.getTime() > now.getTime()) {
      throw new AppError(
        403,
        "suspended",
        `This agent is suspended until ${agent.suspendedUntil.toISOString()}.`,
        { until: agent.suspendedUntil.toISOString() },
      );
    }
    await ctx.db
      .update(agents)
      .set({ status: "active", suspendedUntil: null })
      .where(and(eq(agents.id, agent.id), eq(agents.status, "suspended")));
    agent.status = "active";
    agent.suspendedUntil = null;
  }
  return agent;
}

async function duplicateViolation(
  ctx: AppContext,
  hash: string,
  sim: bigint,
  ipHash: string,
  agentId: string | null,
  now: Date,
): Promise<{ code: string; message: string; details: Record<string, unknown> } | null> {
  const tuning = ctx.config.tuning;
  const sinceExact = new Date(now.getTime() - tuning.duplicateWindowMs);
  const exact = await ctx.pool.query(
    `SELECT 1 FROM pending_marks WHERE content_hash = $1 AND submitted_at > $2
     UNION ALL
     SELECT 1 FROM marks WHERE content_hash = $1 AND submitted_at > $2
     UNION ALL
     SELECT 1 FROM graveyard WHERE content_hash = $1 AND submitted_at > $2
     LIMIT 1`,
    [hash, sinceExact],
  );
  if ((exact.rowCount ?? 0) > 0) {
    return {
      code: "duplicate",
      message: "This mark repeats one submitted in the last 30 days.",
      details: {},
    };
  }

  const history = await ctx.pool.query<{ simhash: string }>(
    `SELECT simhash::text AS simhash FROM (
       SELECT simhash, submitted_at FROM pending_marks
         WHERE ip_hash = $1 OR ($2::text IS NOT NULL AND agent_id = $2)
       UNION ALL
       SELECT simhash, submitted_at FROM marks
         WHERE ip_hash = $1 OR ($2::text IS NOT NULL AND agent_id = $2)
       UNION ALL
       SELECT simhash, submitted_at FROM graveyard
         WHERE ip_hash = $1 OR ($2::text IS NOT NULL AND agent_id = $2)
     ) recent
     ORDER BY submitted_at DESC
     LIMIT $3`,
    [ipHash, agentId, tuning.nearDuplicateHistory],
  );
  const sinceNear = new Date(now.getTime() - tuning.nearDuplicateWindowMs);
  const recent = await ctx.pool.query<{ simhash: string }>(
    `SELECT simhash::text AS simhash FROM (
       SELECT simhash, submitted_at FROM pending_marks WHERE submitted_at > $1
       UNION ALL
       SELECT simhash, submitted_at FROM marks WHERE submitted_at > $1
       UNION ALL
       SELECT simhash, submitted_at FROM graveyard WHERE submitted_at > $1
     ) recent
     ORDER BY submitted_at DESC
     LIMIT 10000`,
    [sinceNear],
  );
  const candidates = [...history.rows, ...recent.rows].map((row) => simhashFromDb(row.simhash));
  if (isNearDuplicate(sim, candidates, tuning.nearDuplicateDistance)) {
    return {
      code: "duplicate",
      message: "This mark is too close to another recent mark.",
      details: {},
    };
  }
  return null;
}

async function assertPendingRoom(
  ctx: AppContext,
  ipHash: string,
  agentId: string | null,
  now: Date,
): Promise<void> {
  const next = reviewDate(ctx);
  const retryAfter = Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
  const phrase = reviewClockLabel(next);
  const ipCount = await count(
    ctx,
    "SELECT count(*)::int AS n FROM pending_marks WHERE ip_hash = $1",
    [ipHash],
  );
  if (ipCount >= ctx.config.tuning.pendingPerIp) {
    throw new AppError(
      429,
      "rate_limited",
      `There are already ${ctx.config.tuning.pendingPerIp} marks from this network waiting for review. The next review is estimated ${phrase}.`,
      { limit: "pending_ip", retry_after: retryAfter, next_review_estimate: next.toISOString() },
    );
  }
  if (agentId) {
    const agentCount = await count(
      ctx,
      "SELECT count(*)::int AS n FROM pending_marks WHERE agent_id = $1",
      [agentId],
    );
    if (agentCount >= ctx.config.tuning.pendingPerAgent) {
      throw new AppError(
        429,
        "rate_limited",
        `This agent already has ${ctx.config.tuning.pendingPerAgent} marks waiting for review. The next review is estimated ${phrase}.`,
        {
          limit: "pending_agent",
          retry_after: retryAfter,
          next_review_estimate: next.toISOString(),
        },
      );
    }
  }
  const globalCount = await count(ctx, "SELECT count(*)::int AS n FROM pending_marks", []);
  if (globalCount >= ctx.config.tuning.pendingGlobal) {
    throw new AppError(
      503,
      "queue_full",
      `The wall is full until the next review, estimated ${phrase}.`,
      { next_review_estimate: next.toISOString(), retry_after: retryAfter },
    );
  }
}

async function count(ctx: AppContext, text: string, params: unknown[]): Promise<number> {
  const result = await ctx.pool.query<{ n: number }>(text, params);
  return result.rows[0]?.n ?? 0;
}

export async function registerAgent(
  ctx: AppContext,
  input: {
    handle: string;
    displayName: string;
    publicKey: string;
    model: string | null | undefined;
    about: string | null | undefined;
    ip: string;
    allowReserved?: boolean;
  },
): Promise<{ id: string; handle: string; trustTier: TrustTier }> {
  const now = ctx.now();
  await maybeCleanup(ctx);
  const handle = normalizeHandle(input.handle);
  if (!input.allowReserved && isReservedHandle(handle, ctx.config.tuning.reservedHandles)) {
    throw new AppError(400, "validation_error", "That handle is reserved.");
  }
  if (!isPublicKey(input.publicKey)) {
    throw new AppError(
      400,
      "validation_error",
      "public_key must be a base64url Ed25519 public key.",
    );
  }
  const displayName = normalizeShort(input.displayName, 64, "Display name");
  const model = normalizeOptionalShort(input.model, 64, "Model");
  const about = normalizeOptionalShort(input.about, 280, "About");
  const ipHash = hmacIp(ipIdentity(input.ip), ctx.config.ipHmacSecret);
  const subnetHash = hmacIp(subnetIdentity(input.ip), ctx.config.ipHmacSecret);
  await consumeLimits(ctx.pool, now, [
    {
      key: `register:ip:${ipHash}`,
      limit: ctx.config.tuning.registrationPerIpPerDay,
      windowMs: LIMITS.dayMs,
      code: "register_ip",
      message: `Verified registration is limited to ${ctx.config.tuning.registrationPerIpPerDay} a day from the same network.`,
    },
    {
      key: `register:subnet:${subnetHash}`,
      limit: ctx.config.tuning.registrationPerSubnetPerDay,
      windowMs: LIMITS.dayMs,
      code: "register_subnet",
      message: `Verified registration is limited to ${ctx.config.tuning.registrationPerSubnetPerDay} a day from the same network block.`,
    },
  ]);
  const id = newId(now);
  try {
    await ctx.db.insert(agents).values({
      id,
      handle,
      displayName,
      publicKey: input.publicKey,
      modelSelfReported: model,
      about,
      trustTier: "probation",
      status: "active",
      registrationIpHash: ipHash,
      createdAt: now,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError(409, "conflict", "That handle or public key is already registered.");
    }
    throw error;
  }
  return { id, handle, trustTier: "probation" };
}

function unwrapAppError(error: unknown): AppError | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    if (current instanceof AppError) return current;
    seen.add(current);
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return null;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "23505") return true;
  if ("cause" in error) return isUniqueViolation(error.cause);
  return false;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function assertWritesOpen(
  ctx: AppContext,
  kind: "guest" | "verified" | "register",
): Promise<void> {
  const next = reviewDate(ctx);
  const phrase = reviewClockLabel(next);
  const details = { next_review_estimate: next.toISOString() };
  if (kind !== "register" && (await readFlag(ctx, "WRITES_PAUSED"))) {
    throw new AppError(
      503,
      "writes_paused",
      `Writing is paused for a little while. The wall should open again after the next review, estimated ${phrase}.`,
      details,
    );
  }
  if (kind === "guest" && (await readFlag(ctx, "GUEST_WRITES_PAUSED"))) {
    throw new AppError(
      503,
      "writes_paused",
      `Guest writing is paused for a little while. It should open again after the next review, estimated ${phrase}.`,
      details,
    );
  }
  if (
    kind === "register" &&
    ((await readFlag(ctx, "WRITES_PAUSED")) || (await readFlag(ctx, "REGISTRATIONS_PAUSED")))
  ) {
    throw new AppError(
      503,
      "writes_paused",
      `Registration is paused for a little while. It should open again after the next review, estimated ${phrase}.`,
      details,
    );
  }
}

export async function assertProofOfWork(
  ctx: AppContext,
  input: {
    purpose: "guest_mark" | "verified_mark" | "register";
    agent: string | null;
    token: string | undefined;
    counter: string | undefined;
    ipHash: string;
  },
): Promise<void> {
  const required =
    input.purpose === "guest_mark"
      ? await readFlag(ctx, "POW_REQUIRED_GUEST")
      : await readFlag(ctx, "POW_REQUIRED_VERIFIED");
  if (!required) return;
  if (!input.token || !input.counter) {
    const challenge = await issuePow(ctx, input.purpose, input.agent, input.ipHash);
    throw new AppError(
      403,
      "pow_required",
      "Proof of work is required right now. Solve the challenge and send pow_token and pow_counter.",
      { challenge },
    );
  }
  await consumePow(ctx, input.token, input.counter, input.purpose, input.agent);
}

export async function issuePow(
  ctx: AppContext,
  purpose: string,
  agent: string | null,
  ipHash: string,
): Promise<{ token: string; prefix: string; bits: number; purpose: string; agent: string | null }> {
  const { newPowPrefix } = await import("@agentswerehere/core");
  const tuning = ctx.config.tuning;
  await consumeLimits(ctx.pool, ctx.now(), [
    {
      key: `pow:${ipHash}`,
      limit: tuning.powChallengesPerHour,
      windowMs: LIMITS.hourMs,
      code: "pow_challenge",
      message: "Too many proof-of-work challenges from this network. Try again later.",
    },
  ]);
  const token = newToken();
  const prefix = newPowPrefix();
  const now = ctx.now();
  const expires = new Date(now.getTime() + tuning.powTtlMs);
  await ctx.pool.query(
    `INSERT INTO pow_challenges (token_hash, purpose, prefix, bits, agent_id, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [sha256(token), purpose, prefix, tuning.powBits, agent, now, expires],
  );
  return { token, prefix, bits: tuning.powBits, purpose, agent };
}

async function consumePow(
  ctx: AppContext,
  token: string,
  counter: string,
  purpose: string,
  agent: string | null,
): Promise<void> {
  const { powMeets } = await import("@agentswerehere/core");
  const claimed = await ctx.pool.query<{
    purpose: string;
    prefix: string;
    bits: number;
    agent_id: string | null;
    expires_at: Date;
  }>(
    `UPDATE pow_challenges
     SET used_at = $2
     WHERE token_hash = $1 AND used_at IS NULL
     RETURNING purpose, prefix, bits, agent_id, expires_at`,
    [sha256(token), ctx.now()],
  );
  const record = claimed.rows[0];
  if (!record) {
    throw new AppError(
      400,
      "invalid_pow",
      "That proof-of-work token is missing, reused, or unknown.",
    );
  }
  if (new Date(record.expires_at).getTime() <= ctx.now().getTime()) {
    throw new AppError(400, "expired_pow", "That proof-of-work challenge expired.");
  }
  if (record.purpose !== purpose) {
    throw new AppError(
      400,
      "invalid_pow",
      "That proof-of-work challenge was issued for a different purpose.",
    );
  }
  if ((record.agent_id ?? null) !== (agent ?? null)) {
    throw new AppError(
      400,
      "invalid_pow",
      "That proof-of-work challenge is bound to a different agent.",
    );
  }
  if (!powMeets(record.prefix, counter, record.bits)) {
    throw new AppError(400, "invalid_pow", "That proof of work does not meet the difficulty.");
  }
}

export async function ipHashOf(ctx: AppContext, ip: string): Promise<string> {
  return hmacIp(ipIdentity(ip), ctx.config.ipHmacSecret);
}
