import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "pg";
import {
  createProspectFromIntake,
  ProspectIntakeConflictError,
  type ProspectIntakeInput,
} from "../../src/intake/prospect-intake.js";

// A scripted in-memory pool: no database is contacted.
function scriptedPool(rowsFor: (sql: string) => unknown[]) {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql.trim());
      return { rows: rowsFor(sql) };
    },
    release: () => undefined,
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    statements,
  };
}

const input = (): ProspectIntakeInput => ({
  requestId: randomUUID(),
  companyName: "Conflict Fixture",
  website: "https://conflict-fixture.com/",
  industry: null,
  contactName: null,
  contactEmail: null,
  primaryDiscoveryQuestion: null,
});

const journalRow = (value: ProspectIntakeInput) => ({
  id: value.requestId,
  prospect_id: randomUUID(),
  identity_key: "https://conflict-fixture.com",
  input_snapshot: {
    companyName: "Different Company",
    website: value.website,
    industry: null,
    contactName: null,
    contactEmail: null,
    primaryDiscoveryQuestion: null,
  },
});

function assertRolledBackWithoutInsert(statements: string[]): void {
  assert.ok(statements.includes("ROLLBACK"));
  assert.ok(!statements.includes("COMMIT"));
  assert.ok(!statements.some((sql) => sql.startsWith("INSERT")));
}

test("Prospect intake conflicts: reused request ID with different input throws a typed conflict", async () => {
  const value = input();
  const { pool, statements } = scriptedPool((sql) =>
    sql.includes("FROM prospect_intake_requests WHERE id = $1")
      ? [journalRow(value)]
      : [],
  );
  await assert.rejects(
    createProspectFromIntake(value, pool),
    ProspectIntakeConflictError,
  );
  assertRolledBackWithoutInsert(statements);
});

test("Prospect intake conflicts: existing identity with different input throws a typed conflict", async () => {
  const value = input();
  const { pool, statements } = scriptedPool((sql) =>
    sql.includes("FROM prospect_intake_requests WHERE identity_key = $1")
      ? [journalRow({ ...value, requestId: randomUUID() })]
      : [],
  );
  await assert.rejects(
    createProspectFromIntake(value, pool),
    ProspectIntakeConflictError,
  );
  assertRolledBackWithoutInsert(statements);
});

test("Prospect intake conflicts: legacy prospect on the same site throws a typed conflict", async () => {
  const { pool, statements } = scriptedPool((sql) =>
    sql.includes("FROM prospects WHERE website IS NOT NULL")
      ? [{ id: randomUUID(), website: "https://CONFLICT-fixture.com/about" }]
      : [],
  );
  await assert.rejects(
    createProspectFromIntake(input(), pool),
    ProspectIntakeConflictError,
  );
  assertRolledBackWithoutInsert(statements);
});

test("Prospect intake conflicts: database failures are not reported as conflicts", async () => {
  const failure = new Error("connection terminated unexpectedly");
  const pool = {
    connect: async () => {
      throw failure;
    },
  } as unknown as Pool;
  await assert.rejects(
    createProspectFromIntake(input(), pool),
    (error: unknown) => {
      assert.equal(error, failure);
      assert.ok(!(error instanceof ProspectIntakeConflictError));
      return true;
    },
  );
});
