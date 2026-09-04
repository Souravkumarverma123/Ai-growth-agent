import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { env } from "../env";
import { closeTestDb, getTestDb, truncateAllTables, TEST_DATABASE_URL, withRollback } from "../testing/db";

/**
 * TICKET-001's required smoke test, finally built (ISSUE-003).
 *
 * Proves the two things TICKET-001 promised and never delivered: (1) tests
 * run against a real, separate Postgres database — a sibling of `dev` on
 * the same server, never `dev` itself — and (2) a test can open a real
 * transaction against it and roll it back, leaving no trace. It also
 * exercises the commit-and-truncate isolation strategy that TICKET-107's
 * concurrency test will depend on, since a transaction-per-test would
 * defeat the point of testing real concurrent commits.
 */

describe("test-database harness (TICKET-001 / ISSUE-003)", () => {
  afterAll(async () => {
    await closeTestDb();
  });

  it("points at a sibling database, never the real dev database", () => {
    expect(TEST_DATABASE_URL).not.toBe(env.DATABASE_URL);

    const devName = new URL(env.DATABASE_URL).pathname.replace(/^\//, "");
    const testName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "");

    expect(testName).toBe(`${devName}_test`);
    expect(testName).not.toBe(devName);
  });

  it("actually connects to the distinct _test database, not just in theory", async () => {
    const db = await getTestDb();
    const rows = await db.execute<{ current_database: string }>(sql`SELECT current_database()`);
    const row = rows.rows[0] as { current_database: string } | undefined;

    expect(row?.current_database).toBeDefined();
    expect(row?.current_database).toMatch(/_test$/);
    expect(row?.current_database).toBe(new URL(TEST_DATABASE_URL).pathname.replace(/^\//, ""));
  });

  it("can open a transaction against the real test database and roll it back", async () => {
    // The row is visible from inside the transaction...
    const insertedName = await withRollback(async (tx) => {
      await tx.execute(sql`CREATE TABLE harness_rollback_probe (name text not null)`);
      await tx.execute(sql`INSERT INTO harness_rollback_probe (name) VALUES ('should not survive')`);

      const rows = await tx.execute<{ name: string }>(sql`SELECT name FROM harness_rollback_probe`);
      return (rows.rows[0] as { name: string } | undefined)?.name;
    });

    expect(insertedName).toBe("should not survive");

    // ...but once withRollback resolves, even the CREATE TABLE itself is
    // gone: Postgres DDL is transactional, so the rollback undoes it too.
    const db = await getTestDb();
    const afterRollback = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'harness_rollback_probe'
      ) AS exists
    `);

    expect((afterRollback.rows[0] as { exists: boolean }).exists).toBe(false);
  });

  it("truncateAllTables clears committed rows without dropping the table", async () => {
    const db = await getTestDb();

    try {
      await db.execute(sql`CREATE TABLE harness_truncate_probe (name text not null)`);
      await db.execute(sql`INSERT INTO harness_truncate_probe (name) VALUES ('committed row')`);

      const before = await db.execute<{ name: string }>(sql`SELECT name FROM harness_truncate_probe`);
      expect(before.rows).toHaveLength(1);

      await truncateAllTables();

      const after = await db.execute<{ name: string }>(sql`SELECT name FROM harness_truncate_probe`);
      expect(after.rows).toHaveLength(0);
    } finally {
      await db.execute(sql`DROP TABLE IF EXISTS harness_truncate_probe`);
    }
  });
});
