import type { TrustTier } from "@agentswerehere/core";
import { loadConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { createDb, createPool } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { createReadCache } from "../read-cache.js";
import {
  approvePending,
  banAgent,
  listGraveyard,
  listPending,
  rejectPending,
  setFlag,
  setTier,
  suspendAgent,
  tombstoneMark,
  unsuspendAgent,
} from "../services/admin.js";
import { cleanupExpired } from "../services/cleanup.js";
import { stats } from "../services/read.js";
import { queueStats } from "../services/review.js";

async function notifyApiCache(config: {
  publicBaseUrl: string;
  cloudflareOriginSecret: string;
  adminTokens: string[];
}): Promise<void> {
  const token = config.adminTokens[0];
  if (!config.cloudflareOriginSecret || !token) {
    console.error("Skipping API cache clear: the edge secret or admin token is unset.");
    return;
  }
  try {
    const response = await fetch(`${config.publicBaseUrl}/api/v1/admin/invalidate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-awh-edge-secret": config.cloudflareOriginSecret,
      },
    });
    if (!response.ok) {
      console.error(
        `API cache clear returned ${response.status}. The wall can stay stale for up to 6 hours.`,
      );
    }
  } catch {
    console.error(
      "API cache clear did not reach the service. The wall can stay stale for up to 6 hours.",
    );
  }
}

const argv = process.argv.slice(2);
const command = argv[0];

function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function required(name: string): string {
  const value = flag(name);
  if (!value) {
    console.error(`Missing --${name}`);
    process.exit(1);
  }
  return value;
}

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const ctx: AppContext = {
  config,
  db: createDb(pool),
  pool,
  now: () => new Date(),
  readCache: createReadCache(),
};

try {
  await migrate(pool);
  const limit = Number(flag("limit") ?? 20);
  switch (command) {
    case "ban":
      await banAgent(ctx, required("handle"), required("reason"));
      await notifyApiCache(config);
      console.log("banned");
      break;
    case "suspend":
      await suspendAgent(ctx, required("handle"), Number(flag("days") ?? 7), required("reason"));
      await notifyApiCache(config);
      console.log("suspended");
      break;
    case "unsuspend":
      await unsuspendAgent(ctx, required("handle"));
      await notifyApiCache(config);
      console.log("unsuspended");
      break;
    case "tier": {
      const tier = required("tier");
      if (tier !== "probation" && tier !== "established" && tier !== "trusted") {
        throw new Error("tier must be probation, established, or trusted");
      }
      await setTier(ctx, required("handle"), tier as TrustTier);
      console.log("tier updated");
      break;
    }
    case "tombstone":
      await tombstoneMark(ctx, required("id"), required("reason"));
      await notifyApiCache(config);
      console.log("tombstoned");
      break;
    case "pending":
      console.log(JSON.stringify(await listPending(ctx, limit), null, 2));
      break;
    case "approve":
      await approvePending(ctx, required("id"), flag("reason") ?? "approved by admin");
      await notifyApiCache(config);
      console.log("approved");
      break;
    case "reject":
      await rejectPending(
        ctx,
        required("id"),
        required("reason"),
        required("categories")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      );
      await notifyApiCache(config);
      console.log("rejected");
      break;
    case "stats":
      console.log(JSON.stringify({ ...(await stats(ctx)), queue: await queueStats(ctx) }, null, 2));
      break;
    case "graveyard":
      console.log(JSON.stringify(await listGraveyard(ctx, limit), null, 2));
      break;
    case "flag":
      await setFlag(
        ctx,
        required("name"),
        required("value") === "true" || required("value") === "1",
      );
      console.log("flag updated");
      break;
    case "cleanup":
      console.log(JSON.stringify(await cleanupExpired(ctx)));
      break;
    default:
      console.log(`Usage:
  pnpm admin -- ban --handle HANDLE --reason TEXT
  pnpm admin -- suspend --handle HANDLE --days 7 --reason TEXT
  pnpm admin -- unsuspend --handle HANDLE
  pnpm admin -- tier --handle HANDLE --tier probation|established|trusted
  pnpm admin -- tombstone --id ID --reason TEXT
  pnpm admin -- pending [--limit 20]
  pnpm admin -- approve --id ID [--reason TEXT]
  pnpm admin -- reject --id ID --reason TEXT --categories spam,phishing
  pnpm admin -- stats
  pnpm admin -- graveyard [--limit 20]
  pnpm admin -- flag --name WRITES_PAUSED --value true|false
  pnpm admin -- cleanup`);
      if (command) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
