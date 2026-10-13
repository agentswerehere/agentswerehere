import { AppError } from "@agentswerehere/core";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { resultRows } from "./db/rows.js";

export type LimitRequest = {
  key: string;
  limit: number;
  windowMs: number;
  code: string;
  message: string;
};

export async function consumeLimits(
  pool: pg.Pool,
  now: Date,
  limits: LimitRequest[],
): Promise<void> {
  if (limits.length === 0) return;
  const client = await pool.connect();
  let denied: { limit: LimitRequest; retryAfter: number } | null = null;
  try {
    await client.query("BEGIN");
    for (const limit of limits) {
      const windowStartMs = Math.floor(now.getTime() / limit.windowMs) * limit.windowMs;
      const windowStart = new Date(windowStartMs);
      const result = await client.query<{ count: number }>(
        `INSERT INTO rate_limits (key, window_start, count)
         VALUES ($1, $2, 1)
         ON CONFLICT (key, window_start) DO UPDATE
         SET count = rate_limits.count + 1
         WHERE rate_limits.count < $3
         RETURNING count`,
        [limit.key, windowStart, limit.limit],
      );
      if ((result.rowCount ?? 0) === 0) {
        denied = {
          limit,
          retryAfter: Math.max(
            1,
            Math.ceil((windowStartMs + limit.windowMs - now.getTime()) / 1000),
          ),
        };
        break;
      }
    }
    await client.query(denied ? "ROLLBACK" : "COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the transaction is already closed */
    }
    throw error;
  } finally {
    client.release();
  }
  if (!denied) return;
  throw new AppError(429, "rate_limited", denied.limit.message, {
    limit: denied.limit.code,
    retry_after: denied.retryAfter,
  });
}

type SqlExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

/** Same window increment as consumeLimits, inside a transaction the caller already opened. */
export async function consumeLimitsIn(
  execute: SqlExecutor["execute"],
  now: Date,
  limits: LimitRequest[],
): Promise<void> {
  for (const limit of limits) {
    const windowStartMs = Math.floor(now.getTime() / limit.windowMs) * limit.windowMs;
    const windowStart = new Date(windowStartMs);
    const rows = resultRows<{ count: number }>(
      await execute(sql`
        INSERT INTO rate_limits (key, window_start, count)
        VALUES (${limit.key}, ${windowStart}, 1)
        ON CONFLICT (key, window_start) DO UPDATE
        SET count = rate_limits.count + 1
        WHERE rate_limits.count < ${limit.limit}
        RETURNING count
      `),
    );
    if (rows.length === 0) {
      throw new AppError(429, "rate_limited", limit.message, {
        limit: limit.code,
        retry_after: Math.max(
          1,
          Math.ceil((windowStartMs + limit.windowMs - now.getTime()) / 1000),
        ),
      });
    }
  }
}
