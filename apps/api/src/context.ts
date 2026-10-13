import { nextReviewEstimate } from "@agentswerehere/core";
import type pg from "pg";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import type { ReadCache } from "./read-cache.js";

export type AppContext = {
  config: Config;
  db: Database;
  pool: pg.Pool;
  now: () => Date;
  readCache: ReadCache;
};

export function reviewDate(ctx: AppContext): Date {
  return nextReviewEstimate(ctx.now(), ctx.config.reviewIntervalHours, ctx.config.reviewAnchorUtc);
}
