import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPool } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";

/**
 * Prefer Docker Postgres when it answers.
 * This environment often cannot open the Docker socket, so tests fall back to PGlite.
 * The app and migrations are the same either way.
 */

const here = dirname(fileURLToPath(import.meta.url));
const servicesPath = join(here, ".services.json");

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://awh:awh@127.0.0.1:5432/awh";
const DOCKER_TEST_URL =
  process.env.DATABASE_URL_TEST ?? "postgres://awh:awh@127.0.0.1:5432/awh_test";

type Held = {
  stop: () => Promise<void>;
};

const held = globalThis as typeof globalThis & { __awhTest?: Held };

type ServicesFile = {
  databaseUrl: string;
  backend: "docker" | "embedded";
};

export async function setup(): Promise<void> {
  const docker = await dockerReady();
  const services: ServicesFile = docker ? await useDocker() : await startEmbedded();
  writeFileSync(servicesPath, JSON.stringify(services));
  const pool = createPool(services.databaseUrl, 4);
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
  console.error(`test services: ${services.backend} postgres=${services.databaseUrl}`);
}

export async function teardown(): Promise<void> {
  await held.__awhTest?.stop();
  held.__awhTest = undefined;
}

async function dockerReady(): Promise<boolean> {
  if (process.env.AWH_FORCE_EMBEDDED === "1") return false;
  return pgAlive(ADMIN_URL);
}

async function useDocker(): Promise<ServicesFile> {
  const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3_000 });
  await admin.connect();
  const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'awh_test'");
  if ((existing.rowCount ?? 0) === 0) {
    await admin.query("CREATE DATABASE awh_test OWNER awh");
  }
  await admin.end();
  held.__awhTest = { stop: async () => undefined };
  return { databaseUrl: DOCKER_TEST_URL, backend: "docker" };
}

async function startEmbedded(): Promise<ServicesFile> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");

  const db = await PGlite.create();
  await db.waitReady;
  const server = new PGLiteSocketServer({
    db,
    port: 0,
    host: "127.0.0.1",
    maxConnections: 20,
  });
  await server.start();
  held.__awhTest = {
    stop: async () => {
      await server.stop();
      await db.close();
    },
  };
  return {
    databaseUrl: `postgres://postgres:postgres@${server.getServerConn()}/postgres`,
    backend: "embedded",
  };
}

async function pgAlive(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1_000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return true;
  } catch {
    try {
      await client.end();
    } catch {
      /* already closed */
    }
    return false;
  }
}
