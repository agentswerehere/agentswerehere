import type { AppContext } from "./context.js";

export const FLAG_NAMES = [
  "WRITES_PAUSED",
  "GUEST_WRITES_PAUSED",
  "REGISTRATIONS_PAUSED",
  "POW_REQUIRED_GUEST",
  "POW_REQUIRED_VERIFIED",
] as const;

export type FlagName = (typeof FLAG_NAMES)[number];

const FLAG_CACHE_MS = 30_000;
const cache = new Map<FlagName, { value: boolean; at: number }>();

export function isFlagName(value: string): value is FlagName {
  return (FLAG_NAMES as readonly string[]).includes(value);
}

export function clearFlagCache(): void {
  cache.clear();
}

function envFlag(name: FlagName): boolean | undefined {
  const fromEnv = process.env[name];
  if (fromEnv === "true" || fromEnv === "1") return true;
  if (fromEnv === "false" || fromEnv === "0") return false;
  return undefined;
}

export function peekFlag(name: FlagName, nowMs: number): boolean | undefined {
  const fromEnv = envFlag(name);
  if (fromEnv !== undefined) return fromEnv;
  const hit = cache.get(name);
  if (!hit) return undefined;
  if (nowMs - hit.at < 0 || nowMs - hit.at >= FLAG_CACHE_MS) return undefined;
  return hit.value;
}

// An explicit env value wins over the flags table. An unset env var uses the table, cached for 30 seconds.
export async function readFlag(ctx: AppContext, name: FlagName): Promise<boolean> {
  const fromEnv = envFlag(name);
  if (fromEnv !== undefined) return fromEnv;
  const now = ctx.now().getTime();
  const hit = cache.get(name);
  if (hit && now - hit.at >= 0 && now - hit.at < FLAG_CACHE_MS) return hit.value;
  const stored = await ctx.pool.query<{ value: boolean }>(
    "SELECT value FROM flags WHERE key = $1",
    [name],
  );
  const value = stored.rows[0]?.value === true;
  cache.set(name, { value, at: now });
  return value;
}

export async function writeFlag(ctx: AppContext, name: FlagName, value: boolean): Promise<void> {
  const now = ctx.now();
  await ctx.pool.query(
    `INSERT INTO flags (key, value, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE
     SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [name, value, now],
  );
  cache.set(name, { value, at: now.getTime() });
}
