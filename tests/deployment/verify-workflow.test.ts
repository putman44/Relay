import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const repositoryRoot = new URL('../../', import.meta.url);

async function readRepositoryFile(path: string) {
  return readFile(new URL(path, repositoryRoot), 'utf8');
}

test('repository verification owns a guarded, collision-safe Docker database', async () => {
  const [packageJson, script] = await Promise.all([
    readRepositoryFile('package.json'),
    readRepositoryFile('scripts/verify.sh'),
  ]);

  assert.equal(JSON.parse(packageJson).scripts.verify, 'bash scripts/verify.sh');
  assert.match(script, /pgvector\/pgvector:0\.8\.1-pg14/);
  assert.match(script, /randomUUID/);
  assert.match(script, /--publish 127\.0\.0\.1::5432/);
  assert.match(script, /POSTGRES_DB=relay_test/);
  assert.match(script, /DOTENV_CONFIG_PATH=\/dev\/null/);
  assert.match(script, /RELAY_TEST_DATABASE_DISPOSABLE=true/);
  assert.match(script, /DATABASE_URL="\$database_url"/);
  assert.match(script, /RELAY_DRAFT_TEST_DATABASE_URL="\$database_url"/);
  assert.match(script, /scripts\/check-test-database\.ts/);
  assert.match(script, /migration_files=\(migrations\/\*\.sql\)/);
  assert.match(script, /npm run typecheck/);
  assert.match(script, /npm test/);
  assert.match(script, /docker container rm --force/);
  assert.match(script, /docker volume rm/);
});

test('pull-request CI runs the repository verification command with a stable check', async () => {
  const workflow = await readRepositoryFile('.github/workflows/verify.yml');

  assert.match(workflow, /^name: verify$/m);
  assert.match(workflow, /^  pull_request:$/m);
  assert.match(workflow, /^      - main$/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /^  cancel-in-progress: true$/m);
  assert.match(workflow, /^    name: verify$/m);
  assert.match(workflow, /^    timeout-minutes: 20$/m);
  assert.match(workflow, /^          ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}$/m);
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /run: npm run verify/);
  assert.doesNotMatch(workflow, /secrets\./);
});
