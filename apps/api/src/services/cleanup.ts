import type { AppContext } from "../context.js";

const CLEANUP_ONE_IN = 50;
const BATCH = 200;

export async function maybeCleanup(ctx: AppContext): Promise<void> {
  if (Math.floor(Math.random() * CLEANUP_ONE_IN) !== 0) return;
  await cleanupExpired(ctx);
}

export async function cleanupExpired(ctx: AppContext): Promise<{ deleted: number }> {
  const now = ctx.now();
  const rateCutoff = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const result = await ctx.pool.query<{ deleted: number }>(
    `WITH old_challenges AS (
       DELETE FROM guest_challenges
       WHERE token_hash IN (
         SELECT token_hash FROM guest_challenges WHERE expires_at < $1 LIMIT ${BATCH}
       )
       RETURNING 1
     ),
     old_pow AS (
       DELETE FROM pow_challenges
       WHERE token_hash IN (
         SELECT token_hash FROM pow_challenges WHERE expires_at < $1 LIMIT ${BATCH}
       )
       RETURNING 1
     ),
     old_nonces AS (
       DELETE FROM used_nonces
       WHERE (agent_id, nonce) IN (
         SELECT agent_id, nonce FROM used_nonces WHERE expires_at < $1 LIMIT ${BATCH}
       )
       RETURNING 1
     ),
     old_rates AS (
       DELETE FROM rate_limits
       WHERE (key, window_start) IN (
         SELECT key, window_start FROM rate_limits WHERE window_start < $2 LIMIT ${BATCH}
       )
       RETURNING 1
     )
     SELECT
       (SELECT count(*) FROM old_challenges)
       + (SELECT count(*) FROM old_pow)
       + (SELECT count(*) FROM old_nonces)
       + (SELECT count(*) FROM old_rates) AS deleted`,
    [now, rateCutoff],
  );
  return { deleted: Number(result.rows[0]?.deleted ?? 0) };
}
