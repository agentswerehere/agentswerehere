import { type NodePgDatabase, drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { log } from "../log.js";
import * as schema from "./schema.js";

export const DB_IDLE_MS = 5 * 60 * 1000;

export type WakeClock = { last: number };

export function noteDbWake(
  clock: WakeClock,
  now: number,
): { wake: boolean; idleMs: number | null } {
  const idleMs = clock.last === 0 ? null : now - clock.last;
  const wake = clock.last === 0 || (idleMs !== null && idleMs > DB_IDLE_MS);
  clock.last = now;
  return { wake, idleMs: wake ? idleMs : null };
}

const wakeClock: WakeClock = { last: 0 };
let queries = 0;
let wakes = 0;

export function dbQueryCount(): number {
  return queries;
}

export function dbWakeCount(): number {
  return wakes;
}

export function resetDbQueryCount(): void {
  queries = 0;
}

export function resetDbWakeCount(): void {
  wakes = 0;
}

export type Database = NodePgDatabase<typeof schema>;

const WAKE_CODES = new Set([
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "XX000",
]);

export function createPool(databaseUrl: string, max = 5): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
    // Startup parameter, so it cannot race the first query on the connection.
    statement_timeout: 15_000,
  });
  const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<pg.QueryResult>;
  pool.query = ((...args: unknown[]) => {
    queries += 1;
    const noted = noteDbWake(wakeClock, Date.now());
    if (noted.wake) {
      wakes += 1;
      log("info", "db_wake", { idle_ms: noted.idleMs });
    }
    return withWakeRetry(() => query(...args));
  }) as typeof pool.query;
  return pool;
}

export function createDb(pool: pg.Pool): Database {
  return drizzle(pool, { schema });
}

async function withWakeRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isWakeError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return await run();
  }
}

function isWakeError(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (WAKE_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : "";
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|Connection terminated|timeout expired|not yet accepting/i.test(
    message,
  );
}
