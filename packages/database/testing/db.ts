import "dotenv/config";
import path from "node:path";
import { Client, Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { env } from "../env";

/**
 * Test-database harness — TICKET-001 / ISSUE-003.
 *
 * Strategy, chosen to require zero docker-compose.yml or ci.yml changes: CI
 * and local dev both provision exactly one Postgres server reachable at
 * DATABASE_URL. Rather than a second service/container, this harness creates
 * a sibling *database* on that same server ("dev" -> "dev_test") the first
 * time a test asks for it, applies the real drizzle migrations to it, and
 * hands back a client bound to it. Nothing here depends on docker-compose or
 * CI specifically — only "a Postgres server reachable at DATABASE_URL's
 * host/port, with permission to create a sibling database," true in both
 * places already.
 *
 * Two isolation strategies are exposed (CONTRACTS.md §8 — "do not mock the
 * database; use the real one"):
 *   - `withRollback` — open a transaction, run inside it, always roll back.
 *     Cheap and fully isolated; the right default for most tests, and what
 *     TICKET-001's required smoke test demonstrates.
 *   - `truncateAllTables` — clear every committed row between test files.
 *     Needed by tests that must observe real commits across separate
 *     connections — e.g. TICKET-107's concurrency test, where wrapping the
 *     whole test in one transaction would defeat the point.
 */

const TEST_DB_SUFFIX = "_test";
const ADMIN_DATABASE_NAME = "postgres"; // present on every standard Postgres install
const DUPLICATE_DATABASE = "42P04"; // Postgres error code: database already exists

function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

function withDatabaseName(url: string, databaseName: string): string {
  const next = new URL(url);
  next.pathname = `/${databaseName}`;
  return next.toString();
}

const devDatabaseName = databaseNameOf(env.DATABASE_URL);
const testDatabaseName = `${devDatabaseName}${TEST_DB_SUFFIX}`;

/** Same server as DATABASE_URL, a different database, never the one "dev" data lives in. */
export const TEST_DATABASE_URL = withDatabaseName(env.DATABASE_URL, testDatabaseName);

const ADMIN_DATABASE_URL = withDatabaseName(env.DATABASE_URL, ADMIN_DATABASE_NAME);

const MIGRATIONS_FOLDER = path.join(__dirname, "..", "drizzle");

async function ensureTestDatabaseExists(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      testDatabaseName,
    ]);
    if (rowCount) return;
    try {
      // Postgres has no `CREATE DATABASE IF NOT EXISTS`, and a database name
      // cannot be a bind parameter. The identifier below is derived from
      // DATABASE_URL above, never from external input.
      await admin.query(`CREATE DATABASE "${testDatabaseName}"`);
    } catch (error) {
      const code = (error as { code?: string }).code;
      // A parallel vitest worker (or a concurrent CI run) created it first —
      // that race ends in the same place either way, so it isn't a failure.
      if (code !== DUPLICATE_DATABASE) throw error;
    }
  } finally {
    await admin.end();
  }
}

let pool: Pool | undefined;
let readyPromise: Promise<NodePgDatabase> | undefined;

async function provision(): Promise<NodePgDatabase> {
  await ensureTestDatabaseExists();
  pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

/**
 * Returns a drizzle client bound to the sibling test database, creating the
 * database and applying migrations on the first call in this process. Safe
 * to call from every test file (and every `it`) — provisioning happens once
 * and the result is cached.
 */
export function getTestDb(): Promise<NodePgDatabase> {
  if (!readyPromise) readyPromise = provision();
  return readyPromise;
}

/** Ends the connection pool. Call once, from a top-level `afterAll`. */
export async function closeTestDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  readyPromise = undefined;
}

const ROLLBACK = Symbol("withRollback sentinel — caught below, never a real failure");

/**
 * Opens a real transaction against the test database, runs `fn` inside it,
 * and always rolls back — on success and on failure alike. `fn`'s return
 * value is still handed back to the caller; only its writes are undone.
 * This is TICKET-001's core acceptance criterion.
 */
export async function withRollback<T>(fn: (tx: NodePgDatabase) => Promise<T>): Promise<T> {
  const db = await getTestDb();
  let result: T | undefined;
  await db
    .transaction(async (tx) => {
      result = await fn(tx);
      throw ROLLBACK;
    })
    .catch((error: unknown) => {
      if (error !== ROLLBACK) throw error;
    });
  return result as T;
}

/**
 * Truncates every table in the `public` schema (drizzle's own migration
 * bookkeeping lives in a separate `drizzle` schema and is untouched, so
 * migrations remain applied and re-running them afterwards is a no-op).
 * Use this between tests that need to commit real data — e.g. TICKET-107's
 * concurrency test.
 */
export async function truncateAllTables(): Promise<void> {
  await getTestDb();
  if (!pool) throw new Error("test database pool is not open");
  const { rows } = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  if (rows.length === 0) return;
  const tableList = rows.map((row) => `"${row.tablename}"`).join(", ");
  await pool.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}
