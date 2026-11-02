import 'dotenv/config';
import { Client } from 'pg';
import { assertVerificationDatabaseOwnership, type VerificationOwnershipRow } from './verification-database-ownership.js';

const connectionString = process.env.DATABASE_URL;
const expectedDraftConnectionString = process.env.RELAY_DRAFT_TEST_DATABASE_URL;
const expectedUser = process.env.RELAY_VERIFY_DATABASE_USER;
const expectedNonce = process.env.RELAY_VERIFY_OWNERSHIP_NONCE;

if (!connectionString || connectionString !== expectedDraftConnectionString
  || !expectedUser || !expectedNonce) {
  throw new Error('Verification database ownership environment is incomplete.');
}

const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });

try {
  await client.connect();
  const result = await client.query<VerificationOwnershipRow>(`SELECT current_user AS database_user,
      current_database() AS database_name,
      current_setting('relay.verification_nonce', true) AS ownership_nonce`);
  assertVerificationDatabaseOwnership(result.rowCount === 1 ? result.rows[0] : undefined,
    expectedUser, expectedNonce);
} finally {
  await client.end().catch(() => undefined);
}
