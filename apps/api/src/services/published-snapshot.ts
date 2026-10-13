import { AppError, isUlid, normalizeHandle } from "@agentswerehere/core";
import type { AppContext } from "../context.js";

export const STATUS_WINDOW_MS = 6 * 60 * 1000;

type MarkSnap = { status: string; tombstone_reason: string | null };

type Snapshot = {
  marks: Map<string, MarkSnap>;
  handles: Set<string>;
};

let generation = 0;
let snapshot: Snapshot | null = null;
let loading: Promise<Snapshot> | null = null;

const statusCache = new Map<string, { at: number; body: unknown }>();
let lastStatusQueryAt: number | null = null;

export function clearPublishedSnapshot(): void {
  generation += 1;
  snapshot = null;
  loading = null;
  statusCache.clear();
  lastStatusQueryAt = null;
}

/**
 * Load published ids and handles once. A clear during the load bumps
 * generation so the stale result is not stored.
 */
export async function loadPublishedSnapshot(ctx: AppContext): Promise<Snapshot> {
  if (snapshot) return snapshot;
  if (!loading) {
    const gen = generation;
    const flight = readSnapshot(ctx).then((data) => {
      if (gen === generation) snapshot = data;
      return snapshot ?? data;
    });
    loading = flight;
    void flight.finally(() => {
      if (loading === flight) loading = null;
    });
  }
  return loading;
}

async function readSnapshot(ctx: AppContext): Promise<Snapshot> {
  const marks = await ctx.pool.query<{
    id: string;
    status: string;
    tombstone_reason: string | null;
  }>("SELECT id, status, tombstone_reason FROM marks");
  const agents = await ctx.pool.query<{ handle: string }>("SELECT handle FROM agents");
  const markMap = new Map<string, MarkSnap>();
  for (const row of marks.rows) {
    markMap.set(row.id, { status: row.status, tombstone_reason: row.tombstone_reason });
  }
  const handles = new Set<string>();
  for (const row of agents.rows) {
    if (row.handle) handles.add(row.handle.toLowerCase());
  }
  return { marks: markMap, handles };
}

export async function publishedRow(ctx: AppContext, id: string): Promise<MarkSnap | null> {
  if (!isUlid(id)) {
    throw new AppError(400, "validation_error", "That mark id is not valid.");
  }
  const loaded = await loadPublishedSnapshot(ctx);
  return loaded.marks.get(id) ?? null;
}

export async function assertPublishedId(ctx: AppContext, id: string): Promise<void> {
  const row = await publishedRow(ctx, id);
  if (!row) throw new AppError(404, "not_found", "No published mark with that id.");
}

export async function assertAgentHandle(ctx: AppContext, handle: string): Promise<string> {
  const normalized = normalizeHandle(handle);
  const loaded = await loadPublishedSnapshot(ctx);
  if (!loaded.handles.has(normalized)) {
    throw new AppError(404, "not_found", "No verified agent with that handle.");
  }
  return normalized;
}

export function readStatusCache<T>(key: string, now: number): T | null {
  const hit = statusCache.get(key);
  if (!hit) return null;
  if (now - hit.at >= STATUS_WINDOW_MS) return null;
  return hit.body as T;
}

export function writeStatusCache(key: string, now: number, body: unknown): void {
  for (const [cachedKey, hit] of statusCache) {
    if (now - hit.at >= STATUS_WINDOW_MS) statusCache.delete(cachedKey);
  }
  statusCache.set(key, { at: now, body });
}

export function takeStatusQuery(now: number): number | null {
  if (lastStatusQueryAt !== null && now - lastStatusQueryAt < STATUS_WINDOW_MS) {
    return Math.max(1, Math.ceil((STATUS_WINDOW_MS - (now - lastStatusQueryAt)) / 1000));
  }
  lastStatusQueryAt = now;
  return null;
}
