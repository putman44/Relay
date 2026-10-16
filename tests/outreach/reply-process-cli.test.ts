import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('Reply CLI: rejects missing confirmation and malformed/extra arguments before provider or database use', () => {
  for (const args of [[], ['--prospect', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ['--prospect', 'bad-id', '--confirm-create-response-draft'],
    ['--prospect', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '--confirm-create-response-draft', '--send']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/process-reply.ts', ...args], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, DATABASE_URL: 'invalid-database-url', OPENAI_API_KEY: '', GOOGLE_REFRESH_TOKEN: '' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Reply processing stopped/);
    assert.doesNotMatch(result.stderr, /TEST_KEY|password|refresh.token/i);
  }
});
