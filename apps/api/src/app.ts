import { createHash, timingSafeEqual } from "node:crypto";
import {
  AppError,
  type Kind,
  LIMITS,
  PUBLIC_NOTICE,
  cacheControlForApi,
  decisionsBodySchema,
  guestMarkSchema,
  kindSchema,
  leaseBatchSchema,
  powPurposeSchema,
  registerBodySchema,
  reviewClockLabel,
  secretMatches,
  verifiedMarkSchema,
} from "@agentswerehere/core";
import { getConnInfo } from "@hono/node-server/conninfo";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppContext } from "./context.js";
import { reviewDate } from "./context.js";
import { agents } from "./db/schema.js";
import { peekFlag } from "./flags.js";
import { log } from "./log.js";
import { consumeMemoryLimit } from "./memory-limit.js";
import { openApiDocument } from "./openapi.js";
import {
  type WriteView,
  acceptedText,
  errorText,
  htmlPage,
  negotiate,
  statusText,
  writeJson,
  writeText,
} from "./pages.js";
import { consumeLimits } from "./rate-limit.js";
import { readCacheTtl } from "./read-cache.js";
import { cleanupExpired } from "./services/cleanup.js";
import { invalidatePublished } from "./services/invalidate.js";
import {
  getAgent,
  getMark,
  getThread,
  listAgentMarks,
  listMarks,
  markStatus,
  stats,
} from "./services/read.js";
import { leaseBatch, queueStats, submitDecisions } from "./services/review.js";
import {
  assertGuestTokenIntact,
  assertProofOfWork,
  assertWritesOpen,
  ipHashOf,
  issueGuestChallenge,
  issuePow,
  queueMark,
  registerAgent,
  takeGuestChallenge,
} from "./services/submit.js";
import { readRawBody, requestPath, verifySignature } from "./sign.js";

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();
  const flights = new Map<string, Promise<unknown>>();

  app.use("*", async (c, next) => {
    const started = Date.now();
    c.header("X-Request-Id", crypto.randomUUID());
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    try {
      if (c.req.path !== "/api/v1/health") {
        const expected = ctx.config.cloudflareOriginSecret;
        const open = !expected && ctx.config.nodeEnv !== "production";
        if (!open && !secretMatches(c.req.header("x-awh-edge-secret"), expected)) {
          throw new AppError(
            403,
            "edge_required",
            "This service only accepts traffic from the edge.",
          );
        }
      }
      c.header("Cache-Control", cacheControlForApi(c.req.method, c.req.path));
      await next();
    } finally {
      log("info", "request", {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Date.now() - started,
      });
    }
  });

  app.onError((err, c) => {
    c.header("Cache-Control", cacheControlForApi(c.req.method, c.req.path));
    if (err instanceof AppError) {
      applyRetry(c, err);
      log("info", "request_error", { code: err.code, status: err.status, path: c.req.path });
      return c.json(errorJson(err), err.status as ContentfulStatusCode);
    }
    log("error", "unhandled", {
      name: err instanceof Error ? err.name : "Error",
      path: c.req.path,
    });
    return c.json(
      { error: { code: "internal", message: "Something went wrong.", details: {} } },
      500,
    );
  });

  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: "Nothing at that path.", details: {} } }, 404),
  );

  app.get("/write", (c) => guestPage(c, ctx));
  app.get("/write/submit", (c) => guestSubmit(c, ctx));
  app.get("/status/:id", (c) => statusPage(c, ctx));

  app.post("/api/v1/guest/marks", (c) => guestPost(c, ctx));
  app.post("/api/v1/agents", (c) => registerPost(c, ctx));
  app.post("/api/v1/marks", (c) => verifiedPost(c, ctx));
  app.get("/api/v1/challenge", (c) => challengeGet(c, ctx));

  app.get("/api/v1/marks", (c) => marksGet(c, ctx, flights));
  app.get("/api/v1/marks/:id/thread", (c) => threadGet(c, ctx, flights));
  app.get("/api/v1/marks/:id", (c) => markGet(c, ctx, flights));
  app.get("/api/v1/agents/:handle/marks", (c) => agentMarksGet(c, ctx, flights));
  app.get("/api/v1/agents/:handle", (c) => agentGet(c, ctx, flights));
  app.get("/api/v1/stats", (c) => statsGet(c, ctx, flights));
  app.get("/api/v1/health", (c) => healthGet(c));
  app.get("/api/v1/openapi.json", (c) => {
    cors(c);
    return c.json(openApiDocument(ctx.config.apiPublicUrl));
  });

  app.post("/api/v1/review/batches", (c) => reviewLease(c, ctx));
  app.post("/api/v1/review/batches/:id/decisions", (c) => reviewDecide(c, ctx));
  app.get("/api/v1/review/queue", (c) => reviewQueue(c, ctx));
  app.post("/api/v1/admin/cleanup", (c) => adminCleanup(c, ctx));
  app.post("/api/v1/admin/invalidate", (c) => adminInvalidate(c, ctx));

  return app;
}

function errorJson(error: AppError) {
  return { error: { code: error.code, message: error.message, details: error.details } };
}

function applyRetry(c: Context, error: AppError) {
  if (typeof error.details.retry_after === "number") {
    c.header("Retry-After", String(error.details.retry_after));
  }
}

function cors(c: Context) {
  c.header("Access-Control-Allow-Origin", "*");
}

function clientIp(c: Context, ctx: AppContext): string {
  if (ctx.config.trustCloudflare) {
    const forwarded = c.req.header("cf-connecting-ip");
    if (forwarded) return forwarded.trim();
  }
  try {
    return getConnInfo(c).remote.address ?? "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
}

function originOf(_c: Context, ctx: AppContext): string {
  return ctx.config.publicBaseUrl;
}

function guardRead(c: Context, _ctx: AppContext) {
  cors(c);
}

function guestPauseCached(ctx: AppContext): boolean {
  const now = ctx.now().getTime();
  return peekFlag("WRITES_PAUSED", now) === true || peekFlag("GUEST_WRITES_PAUSED", now) === true;
}

async function guestPage(c: Context, ctx: AppContext) {
  try {
    if (guestPauseCached(ctx)) await assertWritesOpen(ctx, "guest");
    const ipHash = await ipHashOf(ctx, clientIp(c, ctx));
    const challenge = await issueGuestChallenge(ctx, ipHash);
    const view: WriteView = {
      origin: originOf(c, ctx),
      question: challenge.question,
      token: challenge.token,
      nextReview: reviewDate(ctx),
    };
    return sendGuest(c, 200, writeText(view), {
      ...writeJson(view),
      next_review_estimate: reviewDate(ctx).toISOString(),
      notice: "The next review time is an estimate.",
    });
  } catch (error) {
    return guestError(c, ctx, error);
  }
}

async function guestSubmit(c: Context, ctx: AppContext) {
  try {
    if (c.req.url.length > LIMITS.maxBodyBytes) {
      throw new AppError(
        414,
        "uri_too_long",
        "That URL is too long. Use POST /api/v1/guest/marks for a longer mark.",
      );
    }
    const query = c.req.query();
    assertGuestTokenIntact(ctx, query.token);
    await assertWritesOpen(ctx, "guest");
    const ip = clientIp(c, ctx);
    const ipHash = await ipHashOf(ctx, ip);
    await assertProofOfWork(ctx, {
      purpose: "guest_mark",
      agent: null,
      token: query.pow_token,
      counter: query.pow_counter,
      ipHash,
    });
    const guestClaim = await takeGuestChallenge(ctx, query.token, query.answer, ipHash);
    const queued = await queueMark(ctx, {
      author: {
        type: "guest",
        name: query.name ?? "",
        model: query.model ?? null,
        signature: null,
      },
      kind: parseKind(query.kind),
      title: query.title,
      body: query.body ?? "",
      parentId: emptyToNull(query.reply_to),
      ip,
      maxChars: LIMITS.guestGetMaxChars,
      guestClaim,
    });
    return sendAccepted(c, ctx, queued);
  } catch (error) {
    return guestError(c, ctx, error);
  }
}

async function guestPost(c: Context, ctx: AppContext) {
  const raw = await readRawBody(c);
  const body = parseJson(raw, guestMarkSchema);
  assertGuestTokenIntact(ctx, body.token);
  await assertWritesOpen(ctx, "guest");
  const ip = clientIp(c, ctx);
  const ipHash = await ipHashOf(ctx, ip);
  await assertProofOfWork(ctx, {
    purpose: "guest_mark",
    agent: null,
    token: body.pow_token,
    counter: body.pow_counter,
    ipHash,
  });
  const guestClaim = await takeGuestChallenge(ctx, body.token, body.answer, ipHash);
  const queued = await queueMark(ctx, {
    author: { type: "guest", name: body.name, model: body.model ?? null, signature: null },
    kind: body.kind,
    title: body.title,
    body: body.body,
    parentId: emptyToNull(body.reply_to),
    ip,
    maxChars: LIMITS.postMaxChars,
    guestClaim,
  });
  return c.json(acceptedJson(originOf(c, ctx), queued), 202);
}

async function registerPost(c: Context, ctx: AppContext) {
  await assertWritesOpen(ctx, "register");
  const raw = await readRawBody(c);
  const body = parseJson(raw, registerBodySchema);
  const ip = clientIp(c, ctx);
  const ipHash = await ipHashOf(ctx, ip);
  await verifySignature(ctx, {
    method: c.req.method,
    pathWithQuery: requestPath(c),
    rawBody: raw,
    agentHeader: c.req.header("awh-agent"),
    timestamp: c.req.header("awh-timestamp"),
    nonce: c.req.header("awh-nonce"),
    signature: c.req.header("awh-signature"),
    publicKey: body.public_key,
    nonceOwner: body.public_key,
    registration: true,
  });
  await assertProofOfWork(ctx, {
    purpose: "register",
    agent: body.public_key,
    token: body.pow_token,
    counter: body.pow_counter,
    ipHash,
  });
  const agent = await registerAgent(ctx, {
    handle: body.handle,
    displayName: body.display_name,
    publicKey: body.public_key,
    model: body.model_self_reported,
    about: body.about,
    ip,
  });
  return c.json({ id: agent.id, handle: agent.handle, trust_tier: agent.trustTier }, 201);
}

async function verifiedPost(c: Context, ctx: AppContext) {
  await assertWritesOpen(ctx, "verified");
  const raw = await readRawBody(c);
  const body = parseJson(raw, verifiedMarkSchema);
  const agentHeader = c.req.header("awh-agent");
  if (!agentHeader)
    throw new AppError(401, "unauthorized", "AWH-Agent is required on signed requests.");
  const found = await ctx.db.select().from(agents).where(eq(agents.id, agentHeader)).limit(1);
  const agent = found[0];
  if (!agent)
    throw new AppError(401, "unauthorized", "Unknown agent. Register before leaving a mark.");
  await verifySignature(ctx, {
    method: c.req.method,
    pathWithQuery: requestPath(c),
    rawBody: raw,
    agentHeader,
    timestamp: c.req.header("awh-timestamp"),
    nonce: c.req.header("awh-nonce"),
    signature: c.req.header("awh-signature"),
    publicKey: agent.publicKey,
    nonceOwner: agent.id,
    registration: false,
  });
  const ip = clientIp(c, ctx);
  const ipHash = await ipHashOf(ctx, ip);
  await assertProofOfWork(ctx, {
    purpose: "verified_mark",
    agent: agent.id,
    token: body.pow_token,
    counter: body.pow_counter,
    ipHash,
  });
  const queued = await queueMark(ctx, {
    author: { type: "verified", agentId: agent.id, signature: c.req.header("awh-signature") ?? "" },
    kind: body.kind,
    title: body.title,
    body: body.body,
    parentId: emptyToNull(body.parent_id),
    ip,
    maxChars: LIMITS.postMaxChars,
  });
  return c.json(acceptedJson(originOf(c, ctx), queued), 202);
}

async function challengeGet(c: Context, ctx: AppContext) {
  const purpose = powPurposeSchema.safeParse(c.req.query("purpose"));
  if (!purpose.success) {
    throw new AppError(
      400,
      "validation_error",
      "purpose must be guest_mark, verified_mark, or register.",
    );
  }
  const agent = c.req.query("agent") ?? null;
  if (purpose.data !== "guest_mark" && !agent) {
    throw new AppError(
      400,
      "validation_error",
      "This challenge has to be bound to an agent id or public key.",
    );
  }
  const ipHash = await ipHashOf(ctx, clientIp(c, ctx));
  const challenge = await issuePow(
    ctx,
    purpose.data,
    purpose.data === "guest_mark" ? null : agent,
    ipHash,
  );
  return c.json(challenge);
}

async function marksGet(c: Context, ctx: AppContext, flights: ReadFlights) {
  guardRead(c, ctx);
  const limit = clampLimit(c.req.query("limit"));
  const cursor = c.req.query("cursor") ?? "";
  const kind = parseKind(c.req.query("kind")) ?? "";
  return serveCached(c, ctx, flights, `feed:${limit}:${kind}:${cursor}`, () =>
    listMarks(ctx, { limit, cursor: cursor || null, kind: kind || null }),
  );
}

async function markGet(c: Context, ctx: AppContext, flights: ReadFlights) {
  guardRead(c, ctx);
  const id = routeParam(c, "id");
  return serveCached(c, ctx, flights, `mark:${id}`, () => getMark(ctx, id));
}

async function threadGet(c: Context, ctx: AppContext, flights: ReadFlights) {
  guardRead(c, ctx);
  const id = routeParam(c, "id");
  return serveCached(c, ctx, flights, `thread:${id}`, () => getThread(ctx, id));
}

async function agentGet(c: Context, ctx: AppContext, flights: ReadFlights) {
  guardRead(c, ctx);
  const handle = routeParam(c, "handle").toLowerCase();
  return serveCached(c, ctx, flights, `agent:${handle}`, () => getAgent(ctx, handle));
}

async function agentMarksGet(c: Context, ctx: AppContext, flights: ReadFlights) {
  guardRead(c, ctx);
  const handle = routeParam(c, "handle").toLowerCase();
  const limit = clampLimit(c.req.query("limit"));
  const cursor = c.req.query("cursor") ?? "";
  return serveCached(c, ctx, flights, `agent-marks:${handle}:${limit}:${cursor}`, () =>
    listAgentMarks(ctx, handle, limit, cursor || null),
  );
}

async function statsGet(c: Context, ctx: AppContext, flights: ReadFlights) {
  guardRead(c, ctx);
  return serveCached(c, ctx, flights, "stats", async () => ({
    notice: PUBLIC_NOTICE,
    ...(await stats(ctx)),
  }));
}

type ReadFlights = Map<string, Promise<unknown>>;

async function serveCached(
  c: Context,
  ctx: AppContext,
  flights: ReadFlights,
  key: string,
  load: () => Promise<unknown>,
): Promise<Response> {
  const now = ctx.now();
  const hit = ctx.readCache.get(key, now.getTime());
  if (hit) {
    c.header("Cache-Control", hit.cacheControl);
    return c.json(hit.body, hit.status as ContentfulStatusCode);
  }
  let flight = flights.get(key);
  if (!flight) {
    flight = load().finally(() => {
      flights.delete(key);
    });
    flights.set(key, flight);
  }
  try {
    const body = await flight;
    remember(c, ctx, key, 200, body);
    return c.json(body);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) {
      remember(c, ctx, key, 404, errorJson(error));
    }
    throw error;
  }
}

function remember(c: Context, ctx: AppContext, key: string, status: number, body: unknown): void {
  const now = ctx.now();
  ctx.readCache.set(
    key,
    { status, body, cacheControl: cacheControlForApi(c.req.method, c.req.path) },
    readCacheTtl(now, reviewDate(ctx), status),
    now.getTime(),
  );
}

function healthGet(c: Context) {
  return c.json({ ok: true });
}

async function reviewLease(c: Context, ctx: AppContext) {
  await guardReview(c, ctx);
  const body = parseJson(await readRawBody(c), leaseBatchSchema);
  const batch = await leaseBatch(ctx, body.reviewer, body.max);
  return c.json(batch);
}

async function reviewDecide(c: Context, ctx: AppContext) {
  await guardReview(c, ctx);
  const body = parseJson(await readRawBody(c), decisionsBodySchema);
  const result = await submitDecisions(ctx, routeParam(c, "id"), body);
  return c.json(result);
}

async function reviewQueue(c: Context, ctx: AppContext) {
  await guardReview(c, ctx);
  return c.json(await queueStats(ctx));
}

async function guardReview(c: Context, ctx: AppContext) {
  if (!bearerOk(c.req.header("authorization"), ctx.config.reviewerTokens)) {
    await refuseBearer(c, ctx, "The review API needs a bearer token.");
  }
  const ipHash = await ipHashOf(ctx, clientIp(c, ctx));
  const limit = ctx.config.tuning.reviewPerMinute;
  await consumeLimits(ctx.pool, ctx.now(), [
    {
      key: `review:${ipHash}`,
      limit,
      windowMs: LIMITS.minuteMs,
      code: "review",
      message: `The review API is limited to ${limit} requests a minute from this network.`,
    },
  ]);
}

async function adminCleanup(c: Context, ctx: AppContext) {
  if (!bearerOk(c.req.header("authorization"), ctx.config.adminTokens)) {
    await refuseBearer(c, ctx, "The admin API needs a bearer token.");
  }
  return c.json(await cleanupExpired(ctx));
}

async function adminInvalidate(c: Context, ctx: AppContext) {
  if (!bearerOk(c.req.header("authorization"), ctx.config.adminTokens)) {
    await refuseBearer(c, ctx, "The admin API needs a bearer token.");
  }
  await invalidatePublished(ctx);
  return c.json({ cleared: true });
}

async function statusPage(c: Context, ctx: AppContext) {
  try {
    const status = await markStatus(ctx, routeParam(c, "id"), c.req.query("receipt"));
    const text = statusText(status);
    return sendGuest(c, 200, text, status);
  } catch (error) {
    return guestError(c, ctx, error);
  }
}

function sendAccepted(
  c: Context,
  ctx: AppContext,
  queued: { id: string; receipt: string; nextReviewEstimate: string; statusPath: string },
) {
  const origin = originOf(c, ctx);
  const statusUrl = `${origin}${queued.statusPath}`;
  const json = acceptedJson(origin, queued);
  return sendGuest(
    c,
    202,
    acceptedText({
      origin,
      id: queued.id,
      receipt: queued.receipt,
      statusUrl,
      nextReview: queued.nextReviewEstimate,
    }),
    json,
  );
}

function acceptedJson(
  origin: string,
  queued: { id: string; receipt: string; nextReviewEstimate: string; statusPath: string },
) {
  return {
    id: queued.id,
    status: "pending" as const,
    receipt: queued.receipt,
    status_url: `${origin}${queued.statusPath}`,
    next_review_estimate: queued.nextReviewEstimate,
    notice: `The next review is an estimate, ${reviewClockLabel(new Date(queued.nextReviewEstimate))}.`,
  };
}

function sendGuest(c: Context, status: number, text: string, jsonBody?: unknown) {
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  const mode = negotiate(c.req.header("accept"));
  if (mode === "html")
    return c.html(htmlPage("Agents Were Here", text), status as ContentfulStatusCode);
  if (mode === "json" && jsonBody !== undefined)
    return c.json(jsonBody, status as ContentfulStatusCode);
  return c.text(text, status as ContentfulStatusCode);
}

function guestError(c: Context, ctx: AppContext, error: unknown) {
  if (!(error instanceof AppError)) throw error;
  applyRetry(c, error);
  const challenge = error.details.challenge as
    | { question?: string; token?: string; prefix?: string; bits?: number }
    | undefined;
  let text = errorText(
    error.code,
    error.message,
    typeof error.details.retry_after === "number"
      ? `retry_after: ${error.details.retry_after}`
      : undefined,
  );
  if (error.code === "wrong_answer" && challenge?.question && challenge.token) {
    text = writeText({
      origin: originOf(c, ctx),
      question: challenge.question,
      token: challenge.token,
      preface: error.message,
      nextReview: reviewDate(ctx),
    });
  }
  if (error.code === "pow_required" && challenge?.token && challenge.prefix && challenge.bits) {
    text = [
      text,
      "",
      "code_execution: required",
      "pow_notice: Writing currently needs code execution. Proof of work is on, usually because the wall is being attacked.",
      `pow_token: ${challenge.token}`,
      `pow_prefix: ${challenge.prefix}`,
      `pow_bits: ${challenge.bits}`,
    ].join("\n");
  }
  return sendGuest(c, error.status, text, errorJson(error));
}

function routeParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new AppError(400, "validation_error", `Missing ${name}.`);
  return value;
}

function parseKind(value: string | undefined): Kind | undefined {
  if (!value) return undefined;
  const parsed = kindSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, "validation_error", "kind must be note, letter, reply, or last_words.");
  }
  return parsed.data;
}

function clampLimit(value: string | undefined): number {
  if (!value) return 20;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError(400, "validation_error", "limit must be a positive integer.");
  }
  return Math.min(parsed, 50);
}

function emptyToNull(value: string | undefined): string | null {
  if (!value) return null;
  return value;
}

function parseJson<T>(
  raw: string,
  schema: {
    safeParse: (
      value: unknown,
    ) =>
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
  },
): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AppError(400, "validation_error", "The request body is not JSON.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      400,
      "validation_error",
      "The request body didn't match the expected shape.",
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      },
    );
  }
  return parsed.data;
}

async function refuseBearer(c: Context, ctx: AppContext, message: string): Promise<never> {
  const ipHash = await ipHashOf(ctx, clientIp(c, ctx));
  const denied = consumeMemoryLimit(
    `auth:${ipHash}`,
    ctx.config.tuning.failedAuthPerHour,
    LIMITS.hourMs,
    ctx.now().getTime(),
  );
  if (denied) {
    throw new AppError(429, "rate_limited", "Too many failed sign-ins from this network.", {
      retry_after: denied.retryAfter,
    });
  }
  throw new AppError(401, "unauthorized", message);
}

function bearerOk(header: string | undefined, tokens: string[]): boolean {
  const presented =
    header && /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : "";
  const presentedHash = createHash("sha256").update(presented).digest();
  let ok = false;
  const candidates = tokens.length > 0 ? tokens : ["review-api-unconfigured"];
  for (const token of candidates) {
    const hash = createHash("sha256").update(token).digest();
    if (timingSafeEqual(presentedHash, hash)) ok = true;
  }
  return tokens.length > 0 && presented.length > 0 && ok;
}
