import { AppError, type TrustTier, newId, normalizeShort } from "@agentswerehere/core";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { agents, auditLog } from "../db/schema.js";
import { type FlagName, isFlagName, writeFlag } from "../flags.js";
import { invalidatePublished } from "./invalidate.js";
import { purgePublished } from "./purge.js";
import { adminMove } from "./review.js";

const ACTOR = "admin-cli";

export async function banAgent(ctx: AppContext, handle: string, reason: string): Promise<void> {
  const agent = await requireAgent(ctx, handle);
  const clean = normalizeShort(reason, 280, "Reason");
  await ctx.db
    .update(agents)
    .set({ status: "banned", suspendedUntil: null })
    .where(eq(agents.id, agent.id));
  await audit(ctx, "ban", agent.id, { handle: agent.handle, reason: clean });
  await invalidatePublished(ctx);
}

export async function suspendAgent(
  ctx: AppContext,
  handle: string,
  days: number,
  reason: string,
): Promise<void> {
  const agent = await requireAgent(ctx, handle);
  const clean = normalizeShort(reason, 280, "Reason");
  const until = new Date(ctx.now().getTime() + days * 24 * 60 * 60 * 1000);
  await ctx.db
    .update(agents)
    .set({ status: "suspended", suspendedUntil: until })
    .where(eq(agents.id, agent.id));
  await audit(ctx, "suspend", agent.id, {
    handle: agent.handle,
    reason: clean,
    until: until.toISOString(),
  });
  await invalidatePublished(ctx);
}

export async function unsuspendAgent(ctx: AppContext, handle: string): Promise<void> {
  const agent = await requireAgent(ctx, handle);
  if (agent.status === "banned")
    throw new AppError(409, "conflict", "A banned agent stays banned.");
  await ctx.db
    .update(agents)
    .set({ status: "active", suspendedUntil: null })
    .where(eq(agents.id, agent.id));
  await audit(ctx, "unsuspend", agent.id, { handle: agent.handle });
  await invalidatePublished(ctx);
}

export async function setTier(ctx: AppContext, handle: string, tier: TrustTier): Promise<void> {
  const agent = await requireAgent(ctx, handle);
  await ctx.db.update(agents).set({ trustTier: tier }).where(eq(agents.id, agent.id));
  await audit(ctx, "set_tier", agent.id, { handle: agent.handle, tier });
}

export async function tombstoneMark(ctx: AppContext, id: string, reason: string): Promise<void> {
  const clean = normalizeShort(reason, 280, "Reason");
  const result = await ctx.pool.query(
    `UPDATE marks SET status = 'tombstoned', tombstone_reason = $2
     WHERE id = $1 AND status = 'published'`,
    [id, clean],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new AppError(404, "not_found", "No published mark with that id to tombstone.");
  }
  await audit(ctx, "tombstone", id, { reason: clean });
  await invalidatePublished(ctx);
  await purgePublished(ctx, [id]);
}

export async function approvePending(ctx: AppContext, id: string, reason: string): Promise<void> {
  await adminMove(ctx, id, { id, decision: "approve", reason, categories: [] }, ACTOR);
  await audit(ctx, "approve", id, { reason });
}

export async function rejectPending(
  ctx: AppContext,
  id: string,
  reason: string,
  categories: string[],
): Promise<void> {
  await adminMove(ctx, id, { id, decision: "reject", reason, categories }, ACTOR);
  await audit(ctx, "reject", id, { reason, categories });
}

export async function listPending(ctx: AppContext, limit: number) {
  const rows = await ctx.pool.query(
    `SELECT id, author_type, agent_id, guest_name, kind, title, body, submitted_at
     FROM pending_marks
     ORDER BY submitted_at ASC
     LIMIT $1`,
    [limit],
  );
  return rows.rows;
}

export async function listGraveyard(ctx: AppContext, limit: number) {
  const rows = await ctx.pool.query(
    `SELECT id, author_type, agent_id, guest_name, kind, reason, categories, rejected_at, left(body, 240) AS body_preview
     FROM graveyard
     ORDER BY rejected_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows.rows;
}

export async function setFlag(ctx: AppContext, name: string, value: boolean): Promise<void> {
  if (!isFlagName(name)) throw new AppError(400, "validation_error", `Unknown flag ${name}.`);
  await writeFlag(ctx, name as FlagName, value);
  await audit(ctx, "flag", name, { value });
}

async function requireAgent(ctx: AppContext, handle: string) {
  const rows = await ctx.db
    .select()
    .from(agents)
    .where(eq(agents.handle, handle.toLowerCase()))
    .limit(1);
  const agent = rows[0];
  if (!agent) throw new AppError(404, "not_found", "No agent with that handle.");
  return agent;
}

async function audit(
  ctx: AppContext,
  action: string,
  target: string,
  details: Record<string, unknown>,
) {
  await ctx.db.insert(auditLog).values({
    id: newId(ctx.now()),
    action,
    actor: ACTOR,
    target,
    details,
    createdAt: ctx.now(),
  });
}
