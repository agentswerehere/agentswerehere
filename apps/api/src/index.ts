import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { assertProductionConfig, loadConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { createDb, createPool } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { log } from "./log.js";
import { createReadCache } from "./read-cache.js";

const config = loadConfig();
assertProductionConfig(config);

const pool = createPool(config.databaseUrl);
const ctx: AppContext = {
  config,
  db: createDb(pool),
  pool,
  now: () => new Date(),
  readCache: createReadCache(),
};

if (config.nodeEnv !== "production" || process.env.AWH_MIGRATE_ON_START === "1") {
  await migrate(pool);
}
const server = serve({
  fetch: createApp(ctx).fetch,
  port: config.port,
  hostname: "0.0.0.0",
}) as Server;
server.requestTimeout = 25_000;
log("info", "api_listening", { port: config.port });

async function shutdown() {
  server.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
