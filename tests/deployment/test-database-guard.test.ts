import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = new URL('../../scripts/check-test-database.ts', import.meta.url).pathname;
const local = 'postgresql://relaytest@127.0.0.1:55439/relay_test';

function check(overrides: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', script], {
    cwd: new URL('../../', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: local, RELAY_DRAFT_TEST_DATABASE_URL: local,
      RELAY_TEST_DATABASE_DISPOSABLE: 'true', ...overrides },
    encoding: 'utf8',
  });
}

test('full test guard rejects remote and unconfirmed databases before tests run', () => {
  assert.equal(check({}).status, 0);
  assert.equal(check({ RELAY_TEST_DATABASE_DISPOSABLE: 'false' }).status, 1);
  assert.equal(check({ DATABASE_URL: 'postgresql://user@remote.neon.tech/relay_test' }).status, 1);
  assert.equal(check({ RELAY_DRAFT_TEST_DATABASE_URL: 'postgresql://user@remote.neon.tech/relay_test' }).status, 1);
  assert.equal(check({ DATABASE_URL: 'postgresql://user@127.0.0.1/postgres' }).status, 1);
});
