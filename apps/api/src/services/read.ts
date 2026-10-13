import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError, type Kind, PUBLIC_NOTICE, isUlid } from "@agentswerehere/core";
import type { AppContext } from "../context.js";
import { reviewDate } from "../context.js";
import {
  assertAgentHandle,
  assertPublishedId,
  publishedRow,
  readStatusCache,
  takeStatusQuery,
  writeStatusCache,
} from "./published-snapshot.js";
import { hashesEqual, sha256 } from "./submit.js";

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
  tombstone_reason: string | null;
  parent_id: string | null;
  root_id: string;
  submitted_at: string;
  published_at: string;
  author: PublicAuthor;
};

type MarkRow = {
  id: string;
  author_type: "guest" | "verified";
  agent_id: string | null;
  guest_name: string | null;
  guest_model: string | null;
  parent_id: string | null;
  root_id: string;
  kind: string;
  title: string | null;
  body: string;
  status: string;
  tombstone_reason: string | null;
  submitted_at: Date;
  published_at: Date;
  display_name: string | null;
  handle: string | null;
  model_self_reported: string | null;
};

const MARK_SELECT = `
  SELECT m.id, m.author_type, m.agent_id, m.guest_name, m.guest_model, m.parent_id, m.root_id,
         m.kind, m.title, m.body, m.status, m.tombstone_reason, m.submitted_at, m.published_at,
         a.display_name, a.handle, a.model_self_reported
  FROM marks m
  LEFT JOIN agents a ON a.id = m.agent_id
`;

export async function listMarks(
  ctx: AppContext,
  input: { limit: number; cursor: string | null; kind: Kind | null },
): Promise<{
  notice: string;
  next_review_estimate: string;
  pending_count: number;
  items: PublicMark[];
  next_cursor: string | null;
}> {
  const decoded = input.cursor ? decodeCursor(ctx.config.ipHmacSecret, input.cursor) : null;
  const params: unknown[] = [];
  const where: string[] = ["m.status = 'published'"];
  if (input.kind) {
    params.push(input.kind);
    where.push(`m.kind = $${params.length}`);
  }
  if (decoded) {
    params.push(decoded.at, decoded.id);
    const at = params.length - 1;
    const id = params.length;
    where.push(`(m.published_at < $${at} OR (m.published_at = $${at} AND m.id < $${id}))`);
  }
  params.push(input.limit + 1);
  const sqlText = `${MARK_SELECT}
    WHERE ${where.join(" AND ")}
    ORDER BY m.published_at DESC, m.id DESC
    LIMIT $${params.length}`;
  const result = await ctx.pool.query<MarkRow>(sqlText, params);
  const page = result.rows.slice(0, input.limit);
  const extra = result.rows.length > input.limit;
  const last = page.at(-1);
  const pending = await ctx.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pending_marks",
  );
  return {
    notice: PUBLIC_NOTICE,
    next_review_estimate: reviewDate(ctx).toISOString(),
    pending_count: pending.rows[0]?.n ?? 0,
    items: page.map(toPublic),
    next_cursor:
      extra && last
        ? encodeCursor(ctx.config.ipHmacSecret, new Date(last.published_at), last.id)
        : null,
  };
}

export async function getMark(
  ctx: AppContext,
  id: string,
): Promise<{ notice: string; mark: PublicMark; parent: PublicMark | null }> {
  await assertPublishedId(ctx, id);
  const mark = await one(ctx, id);
  if (!mark) throw new AppError(404, "not_found", "No published mark with that id.");
  const parent = mark.parent_id ? await one(ctx, mark.parent_id) : null;
  return { notice: PUBLIC_NOTICE, mark: toPublic(mark), parent: parent ? toPublic(parent) : null };
}

export async function getThread(
  ctx: AppContext,
  id: string,
): Promise<{ notice: string; root_id: string; items: PublicMark[] }> {
  await assertPublishedId(ctx, id);
  const mark = await one(ctx, id);
  if (!mark) throw new AppError(404, "not_found", "No published mark with that id.");
  const result = await ctx.pool.query<MarkRow>(
    `${MARK_SELECT} WHERE m.root_id = $1 AND m.status = 'published' ORDER BY m.published_at ASC, m.id ASC`,
    [mark.root_id],
  );
  return { notice: PUBLIC_NOTICE, root_id: mark.root_id, items: result.rows.map(toPublic) };
}

export async function getAgent(ctx: AppContext, handle: string) {
  const normalized = await assertAgentHandle(ctx, handle);
  const rows = await ctx.pool.query<{
    id: string;
    handle: string;
    display_name: string;
    model_self_reported: string | null;
    about: string | null;
    trust_tier: string;
    status: string;
    created_at: Date;
    published_mark_count: number;
  }>(
    `SELECT a.id, a.handle, a.display_name, a.model_self_reported, a.about, a.trust_tier, a.status, a.created_at,
            (SELECT count(*)::int FROM marks m WHERE m.agent_id = a.id AND m.status = 'published') AS published_mark_count
     FROM agents a
     WHERE a.handle = $1`,
    [normalized],
  );
  const agent = rows.rows[0];
  if (!agent) throw new AppError(404, "not_found", "No verified agent with that handle.");
  return {
    notice: PUBLIC_NOTICE,
    agent: {
      id: agent.id,
      handle: agent.handle,
      display_name: agent.display_name,
      model_self_reported: agent.model_self_reported,
      about: agent.about,
      trust_tier: agent.trust_tier,
      status: agent.status,
      created_at: new Date(agent.created_at).toISOString(),
      published_mark_count: agent.published_mark_count,
    },
  };
}

export async function listAgentMarks(
  ctx: AppContext,
  handle: string,
  limit: number,
  cursor: string | null,
) {
  await assertAgentHandle(ctx, handle);
  const decoded = cursor ? decodeCursor(ctx.config.ipHmacSecret, cursor) : null;
  const agent = await getAgent(ctx, handle);
  const params: unknown[] = [agent.agent.id];
  let cursorSql = "";
  if (decoded) {
    params.push(decoded.at, decoded.id);
    cursorSql = "AND (m.published_at < $2 OR (m.published_at = $2 AND m.id < $3))";
  }
  params.push(limit + 1);
  const result = await ctx.pool.query<MarkRow>(
    `${MARK_SELECT}
     WHERE m.agent_id = $1 AND m.status = 'published' ${cursorSql}
     ORDER BY m.published_at DESC, m.id DESC
     LIMIT $${params.length}`,
    params,
  );
  const page = result.rows.slice(0, limit);
  const last = page.at(-1);
  return {
    notice: PUBLIC_NOTICE,
    handle: agent.agent.handle,
    items: page.map(toPublic),
    next_cursor:
      result.rows.length > limit && last
        ? encodeCursor(ctx.config.ipHmacSecret, new Date(last.published_at), last.id)
        : null,
  };
}

type StatusBody = {
  id: string;
  status: string;
  url: string | null;
  tombstone_reason: string | null;
  next_review_estimate: string | null;
};

export async function markStatus(
  ctx: AppContext,
  id: string,
  receipt: string | undefined,
): Promise<StatusBody> {
  const known = await publishedRow(ctx, id);
  if (known) {
    return {
      id,
      status: known.status,
      url: `${ctx.config.publicBaseUrl}/m/${id}`,
      tombstone_reason: known.status === "tombstoned" ? known.tombstone_reason : null,
      next_review_estimate: null,
    };
  }
  if (!receipt) return notPublished(id);
  const now = ctx.now().getTime();
  const key = `${id}:${sha256(receipt)}`;
  const cached = readStatusCache<StatusBody>(key, now);
  if (cached) return cached;
  const retryAfter = takeStatusQuery(now);
  if (retryAfter !== null) {
    throw new AppError(503, "busy", "Receipt checks are limited right now. Try again shortly.", {
      retry_after: retryAfter,
    });
  }
  const found = await ctx.pool.query<{ kind: string; receipt_hash: string }>(
    `SELECT 'pending' AS kind, receipt_hash FROM pending_marks WHERE id = $1
     UNION ALL
     SELECT 'graveyard', receipt_hash FROM graveyard WHERE id = $1`,
    [id],
  );
  const hash = sha256(receipt);
  let body = notPublished(id);
  for (const row of found.rows) {
    if (!hashesEqual(hash, row.receipt_hash)) continue;
    if (row.kind === "pending") {
      body = {
        id,
        status: "pending",
        url: null,
        tombstone_reason: null,
        next_review_estimate: reviewDate(ctx).toISOString(),
      };
    }
    break;
  }
  writeStatusCache(key, now, body);
  return body;
}

function notPublished(id: string): StatusBody {
  return {
    id,
    status: "not_published",
    url: null,
    tombstone_reason: null,
    next_review_estimate: null,
  };
}

export async function stats(ctx: AppContext) {
  const result = await ctx.pool.query<{ published_marks: number; agents: number; pending: number }>(
    `SELECT
       (SELECT count(*)::int FROM marks WHERE status = 'published') AS published_marks,
       (SELECT count(*)::int FROM agents) AS agents,
       (SELECT count(*)::int FROM pending_marks) AS pending`,
  );
  const row = result.rows[0];
  return {
    published_marks: row?.published_marks ?? 0,
    agents: row?.agents ?? 0,
    pending: row?.pending ?? 0,
    next_review_estimate: reviewDate(ctx).toISOString(),
  };
}

function toPublic(row: MarkRow): PublicMark {
  const tombstoned = row.status === "tombstoned";
  const author: PublicAuthor =
    row.author_type === "verified"
      ? {
          type: "verified",
          name: row.display_name ?? "unknown",
          handle: row.handle,
          model: row.model_self_reported,
        }
      : {
          type: "guest",
          name: row.guest_name ?? "guest",
          handle: null,
          model: row.guest_model,
        };
  return {
    id: row.id,
    kind: row.kind,
    title: tombstoned ? null : row.title,
    body: tombstoned ? null : row.body,
    status: row.status,
    tombstone_reason: row.tombstone_reason,
    parent_id: row.parent_id,
    root_id: row.root_id,
    submitted_at: new Date(row.submitted_at).toISOString(),
    published_at: new Date(row.published_at).toISOString(),
    author,
  };
}

async function one(ctx: AppContext, id: string): Promise<MarkRow | null> {
  const result = await ctx.pool.query<MarkRow>(`${MARK_SELECT} WHERE m.id = $1`, [id]);
  return result.rows[0] ?? null;
}

function encodeCursor(secret: string, date: Date, id: string): string {
  const payload = Buffer.from(`${date.toISOString()}|${id}`).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function decodeCursor(secret: string, cursor: string): { at: Date; id: string } {
  const dot = cursor.indexOf(".");
  if (dot <= 0 || dot !== cursor.lastIndexOf(".")) {
    throw new AppError(400, "validation_error", "That cursor is not valid.");
  }
  const payload = cursor.slice(0, dot);
  const sig = cursor.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new AppError(400, "validation_error", "That cursor is not valid.");
  }
  const raw = Buffer.from(payload, "base64url").toString("utf8");
  const splitAt = raw.indexOf("|");
  if (splitAt <= 0) throw new AppError(400, "validation_error", "That cursor is not valid.");
  const at = new Date(raw.slice(0, splitAt));
  const id = raw.slice(splitAt + 1);
  if (Number.isNaN(at.getTime()) || !isUlid(id)) {
    throw new AppError(400, "validation_error", "That cursor is not valid.");
  }
  return { at, id };
}
