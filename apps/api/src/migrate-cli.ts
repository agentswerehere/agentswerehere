import { loadConfig } from "./config.js";
import { createPool } from "./db/client.js";
import { migrate } from "./db/migrate.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
await migrate(pool);
await pool.end();
console.log("migrations applied");
