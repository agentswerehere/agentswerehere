import { AppError, LIMITS, REVIEW_BATCH_NOTICE, newId, simhashToDb } from "@agentswerehere/core";
import { sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { reviewDate } from "../context.js";
import { resultRows } from "../db/rows.js";
import { invalidatePublished } from "./invalidate.js";
import { purgePublished } from "./purge.js";
import { blockUntil } from "./submit.js";

export type PendingItem = {
  id: string;
  author_type: string;
  agent_id: string | null;
  guest_name: string | null;
  guest_model: string | null;
  parent_id: string | null;
  kind: string;
  title: string | null;
  body: string;
  content_hash: string;
  simhash: string;
  ip_hash: string;
  signature: string | null;
  receipt_hash: string;
  submitted_at: string;
  lease_id: string | null;
  leased_until: string | null;
};

type Decision = {
  id: string;
  decision: "approve" | "reject";
  reason: string;
  categories: string[];
};

export async function leaseBatch(
  ctx: AppContext,
  reviewer: string,
  requestedMax: number | undefined,
): Promise<{
  batch_id: string;
  leased_until: string;
  notice: string;
  items: PendingItem[];
  text: string;
}> {
  const now = ctx.now();
  const max = Math.min(requestedMax ?? 100, 100);
  if (max < 1) throw new AppError(400, "validation_error", "max must be at least 1.");
  const batchId = newId(now);
  const leasedUntil = new Date(now.getTime() + LIMITS.leaseMs);
  const items = await ctx.db.transaction(async (tx) => {
    const picked = resultRows<Record<string, unknown>>(
      await tx.execute(sql`
        WITH picked AS (
          SELECT id FROM pending_marks
          WHERE lease_id IS NULL OR leased_until < ${now}
          ORDER BY submitted_at ASC, id ASC
          LIMIT ${max}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE pending_marks AS p
        SET lease_id = ${batchId}, leased_until = ${leasedUntil}
        FROM picked
        WHERE p.id = picked.id
        RETURNING p.*
      `),
    );
    const ordered = picked
      .map(toPendingItem)
      .sort(
        (left, right) =>
          left.submitted_at.localeCompare(right.submitted_at) || left.id.localeCompare(right.id),
      );
    await tx.execute(sql`
      INSERT INTO review_batches (id, reviewer, created_at, leased_until, item_count)
      VALUES (${batchId}, ${reviewer}, ${now}, ${leasedUntil}, ${ordered.length})
    `);
    return ordered;
  });
  return {
    batch_id: batchId,
    leased_until: leasedUntil.toISOString(),
    notice: REVIEW_BATCH_NOTICE,
    items,
    text: renderBatchText(items),
  };
}

export async function submitDecisions(
  ctx: AppContext,
  batchId: string,
  body: { batch_id: string; decisions: Decision[] },
): Promise<{ batch_id: string; approved: number; rejected: number; released: number }> {
  if (body.batch_id !== batchId) {
    throw new AppError(
      400,
      "invalid_decision",
      "batch_id does not match the URL. Nothing was changed.",
    );
  }
  const now = ctx.now();
  const batch = await ctx.pool.query<{
    id: string;
    reviewer: string;
    leased_until: Date;
    completed_at: Date | null;
  }>("SELECT id, reviewer, leased_until, completed_at FROM review_batches WHERE id = $1", [
    batchId,
  ]);
  const header = batch.rows[0];
  if (!header) throw new AppError(404, "not_found", "No review batch with that id.");
  if (header.completed_at) {
    throw new AppError(409, "conflict", "This batch was already submitted. Nothing was changed.");
  }
  if (new Date(header.leased_until).getTime() < now.getTime()) {
    throw new AppError(
      409,
      "lease_expired",
      "This batch lease expired. Lease the marks again. Nothing was changed.",
    );
  }

  const leased = await ctx.pool.query<{ id: string }>(
    "SELECT id FROM pending_marks WHERE lease_id = $1",
    [batchId],
  );
  const leasedIds = new Set(leased.rows.map((row) => row.id));
  const seen = new Set<string>();
  for (const decision of body.decisions) {
    if (seen.has(decision.id)) {
      throw new AppError(
        400,
        "invalid_decision",
        `Mark ${decision.id} appears twice. Nothing was changed.`,
      );
    }
    seen.add(decision.id);
    if (!leasedIds.has(decision.id)) {
      throw new AppError(
        400,
        "invalid_decision",
        `Unknown mark id ${decision.id} is not in this batch. Nothing was changed.`,
      );
    }
    if (
      decision.decision === "reject" &&
      (decision.reason.trim().length === 0 || decision.categories.length === 0)
    ) {
      throw new AppError(
        400,
        "invalid_decision",
        "A rejection needs a reason and at least one category. Nothing was changed.",
      );
    }
  }

  const approved = body.decisions.filter((decision) => decision.decision === "approve");
  const rejected = body.decisions.filter((decision) => decision.decision === "reject");
  const undecided = [...leasedIds].filter((id) => !seen.has(id));

  await ctx.db.transaction(async (tx) => {
    for (const decision of approved) {
      await moveApproved(tx, decision.id, batchId, header.reviewer, now, ctx);
    }
    for (const decision of rejected) {
      await moveRejected(tx, decision, batchId, header.reviewer, now, ctx);
    }
    if (undecided.length > 0) {
      await tx.execute(sql`
        UPDATE pending_marks
        SET lease_id = NULL, leased_until = NULL
        WHERE lease_id = ${batchId}
          AND id IN (${sql.join(
            undecided.map((id) => sql`${id}`),
            sql`, `,
          )})
      `);
    }
    await tx.execute(sql`
      UPDATE review_batches
      SET approved_count = ${approved.length},
          rejected_count = ${rejected.length},
          completed_at = ${now}
      WHERE id = ${batchId}
    `);
  });

  await invalidatePublished(ctx);
  if (approved.length > 0) {
    await purgePublished(
      ctx,
      approved.map((decision) => decision.id),
    );
  }

  return {
    batch_id: batchId,
    approved: approved.length,
    rejected: rejected.length,
    released: undecided.length,
  };
}

type Executor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

async function moveApproved(
  tx: Executor,
  id: string,
  batchId: string,
  reviewer: string,
  now: Date,
  ctx: AppContext,
): Promise<void> {
  const inserted = resultRows<{ agent_id: string | null }>(
    await tx.execute(sql`
      INSERT INTO marks (
        id, author_type, agent_id, guest_name, guest_model, parent_id, root_id, kind, title, body,
        content_hash, simhash, ip_hash, signature, status, reviewed_by, submitted_at, published_at
      )
      SELECT
        p.id, p.author_type, p.agent_id, p.guest_name, p.guest_model, p.parent_id,
        COALESCE(parent.root_id, p.id),
        p.kind, p.title, p.body, p.content_hash, p.simhash, p.ip_hash, p.signature,
        'published', ${reviewer}, p.submitted_at, ${now}
      FROM pending_marks p
      LEFT JOIN marks parent ON parent.id = p.parent_id
      WHERE p.id = ${id} AND p.lease_id = ${batchId}
      RETURNING agent_id
    `),
  );
  if (inserted.length !== 1) {
    throw new AppError(
      409,
      "conflict",
      `Mark ${id} could not be approved. Nothing else in this attempt was kept.`,
    );
  }
  await tx.execute(sql`DELETE FROM pending_marks WHERE id = ${id} AND lease_id = ${batchId}`);
  const agentId = inserted[0]?.agent_id;
  if (agentId) await maybePromote(tx, agentId, now, ctx);
}

async function moveRejected(
  tx: Executor,
  decision: Decision,
  batchId: string,
  reviewer: string,
  now: Date,
  ctx: AppContext,
): Promise<void> {
  const inserted = resultRows<{ agent_id: string | null }>(
    await tx.execute(sql`
      INSERT INTO graveyard (
        id, author_type, agent_id, guest_name, guest_model, parent_id, kind, title, body,
        content_hash, simhash, ip_hash, signature, receipt_hash, submitted_at, lease_id, leased_until,
        rejected_at, reviewed_by, reason, categories
      )
      SELECT
        id, author_type, agent_id, guest_name, guest_model, parent_id, kind, title, body,
        content_hash, simhash, ip_hash, signature, receipt_hash, submitted_at, lease_id, leased_until,
        ${now}, ${reviewer}, ${decision.reason}, ${textArray(decision.categories)}
      FROM pending_marks
      WHERE id = ${decision.id} AND lease_id = ${batchId}
      RETURNING agent_id
    `),
  );
  if (inserted.length !== 1) {
    throw new AppError(
      409,
      "conflict",
      `Mark ${decision.id} could not be rejected. Nothing else in this attempt was kept.`,
    );
  }
  await tx.execute(sql`DELETE FROM pending_marks WHERE id = ${decision.id}`);
  const agentId = inserted[0]?.agent_id;
  if (agentId) await maybeSuspend(tx, agentId, now, ctx);
}

async function maybePromote(
  tx: Executor,
  agentId: string,
  now: Date,
  ctx: AppContext,
): Promise<void> {
  const cutoff = new Date(now.getTime() - ctx.config.tuning.promotionAgeMs);
  await tx.execute(sql`
    UPDATE agents
    SET trust_tier = 'established'
    WHERE id = ${agentId}
      AND trust_tier = 'probation'
      AND created_at <= ${cutoff}
      AND (SELECT count(*) FROM marks WHERE agent_id = ${agentId} AND status = 'published') >= ${ctx.config.tuning.promotionMarks}
      AND NOT EXISTS (SELECT 1 FROM graveyard WHERE agent_id = ${agentId})
  `);
}

async function maybeSuspend(
  tx: Executor,
  agentId: string,
  now: Date,
  ctx: AppContext,
): Promise<void> {
  const rows = resultRows<{ rejected_at: Date | string }>(
    await tx.execute(sql`
      SELECT rejected_at FROM graveyard
      WHERE agent_id = ${agentId}
      ORDER BY rejected_at DESC
      LIMIT 30
    `),
  );
  const until = blockUntil(
    rows.map((row) => new Date(row.rejected_at)),
    now,
    ctx,
  );
  if (!until) return;
  await tx.execute(sql`
    UPDATE agents
    SET status = 'suspended',
        suspended_until = CASE
          WHEN suspended_until IS NULL OR suspended_until < ${until} THEN ${until}
          ELSE suspended_until
        END
    WHERE id = ${agentId} AND status <> 'banned'
  `);
}

export async function adminMove(
  ctx: AppContext,
  id: string,
  decision: Decision,
  actor: string,
): Promise<void> {
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    const locked = resultRows<{ id: string }>(
      await tx.execute(sql`SELECT id FROM pending_marks WHERE id = ${id} FOR UPDATE`),
    );
    if (locked.length !== 1) throw new AppError(404, "not_found", "No pending mark with that id.");
    await tx.execute(sql`
      UPDATE pending_marks
      SET lease_id = ${`admin:${id}`}, leased_until = ${new Date(now.getTime() + LIMITS.leaseMs)}
      WHERE id = ${id}
    `);
    if (decision.decision === "approve") {
      await moveApproved(tx, id, `admin:${id}`, actor, now, ctx);
    } else {
      if (decision.reason.trim().length === 0 || decision.categories.length === 0) {
        throw new AppError(
          400,
          "validation_error",
          "A rejection needs a reason and at least one category.",
        );
      }
      await moveRejected(tx, decision, `admin:${id}`, actor, now, ctx);
    }
  });
  await invalidatePublished(ctx);
  if (decision.decision === "approve") await purgePublished(ctx, [id]);
}

export async function queueStats(ctx: AppContext): Promise<{
  pending: number;
  leased: number;
  oldest_pending_age_seconds: number | null;
  next_review_estimate: string;
}> {
  const now = ctx.now();
  const counts = await ctx.pool.query<{ pending: number; leased: number; oldest: Date | null }>(
    `SELECT
       count(*)::int AS pending,
       count(*) FILTER (WHERE lease_id IS NOT NULL AND leased_until >= $1)::int AS leased,
       min(submitted_at) AS oldest
     FROM pending_marks`,
    [now],
  );
  const row = counts.rows[0];
  const oldest = row?.oldest ? new Date(row.oldest) : null;
  return {
    pending: row?.pending ?? 0,
    leased: row?.leased ?? 0,
    oldest_pending_age_seconds: oldest
      ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000))
      : null,
    next_review_estimate: reviewDate(ctx).toISOString(),
  };
}

export function renderBatchText(items: PendingItem[]): string {
  const blocks = items.map((item) =>
    [
      `===== MARK ${item.id} =====`,
      `id: ${item.id}`,
      `author_type: ${item.author_type}`,
      `agent_id: ${item.agent_id ?? ""}`,
      `guest_name: ${item.guest_name ?? ""}`,
      `guest_model: ${item.guest_model ?? ""}`,
      `kind: ${item.kind}`,
      `title: ${item.title ?? ""}`,
      `parent_id: ${item.parent_id ?? ""}`,
      `submitted_at: ${item.submitted_at}`,
      `----- BODY ${item.id} (untrusted) -----`,
      item.body,
      `----- END BODY ${item.id} -----`,
      `===== END MARK ${item.id} =====`,
    ].join("\n"),
  );
  return [REVIEW_BATCH_NOTICE, "", ...blocks].join("\n\n");
}

function textArray(values: string[]) {
  if (values.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

function toPendingItem(row: Record<string, unknown>): PendingItem {
  const submitted = row.submitted_at;
  const leased = row.leased_until;
  return {
    id: String(row.id),
    author_type: String(row.author_type),
    agent_id: (row.agent_id as string | null) ?? null,
    guest_name: (row.guest_name as string | null) ?? null,
    guest_model: (row.guest_model as string | null) ?? null,
    parent_id: (row.parent_id as string | null) ?? null,
    kind: String(row.kind),
    title: (row.title as string | null) ?? null,
    body: String(row.body),
    content_hash: String(row.content_hash),
    simhash: typeof row.simhash === "bigint" ? simhashToDb(row.simhash) : String(row.simhash),
    ip_hash: String(row.ip_hash),
    signature: (row.signature as string | null) ?? null,
    receipt_hash: String(row.receipt_hash),
    submitted_at: submitted instanceof Date ? submitted.toISOString() : String(submitted),
    lease_id: (row.lease_id as string | null) ?? null,
    leased_until: leased instanceof Date ? leased.toISOString() : leased ? String(leased) : null,
  };
}
