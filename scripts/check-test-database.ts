import 'dotenv/config';
import { Client } from 'pg';

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const names = ['DATABASE_URL', 'RELAY_DRAFT_TEST_DATABASE_URL'] as const;

if (process.env.RELAY_TEST_DATABASE_DISPOSABLE !== 'true') {
  throw new Error('Full tests require RELAY_TEST_DATABASE_DISPOSABLE=true and an isolated local relay_test database.');
}

for (const name of names) {
  const value = process.env[name];
  let url: URL;
  let effectiveHost: string;
  let effectiveDatabase: string | undefined;
  try {
    url = new URL(value ?? '');
    const client = new Client({ connectionString: value });
    effectiveHost = client.host;
    effectiveDatabase = client.database;
  } catch { throw new Error(`${name} must be a local disposable Postgres URL for full tests.`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !localHosts.has(url.hostname) || decodeURIComponent(url.pathname) !== '/relay_test'
    || !localHosts.has(effectiveHost) || effectiveDatabase !== 'relay_test') {
    throw new Error(`${name} must target a local database named relay_test; remote databases are refused.`);
  }
}
