import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertVerificationDatabaseOwnership } from '../../scripts/verification-database-ownership.js';

const repositoryRootUrl = new URL('../../', import.meta.url);
const repositoryRoot = fileURLToPath(repositoryRootUrl);

async function readRepositoryFile(path: string) {
  return readFile(new URL(path, repositoryRootUrl), 'utf8');
}

type FakeVerification = {
  directory: string;
  logPath: string;
  statePath: string;
  run: (overrides?: NodeJS.ProcessEnv) => ReturnType<typeof spawnSync>;
};

async function writeExecutable(path: string, source: string) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

async function createFakeVerification(): Promise<FakeVerification> {
  const directory = await mkdtemp(join(tmpdir(), 'relay-verify-test-'));
  const binDirectory = join(directory, 'bin');
  const logPath = join(directory, 'commands.log');
  const statePath = join(directory, 'state.json');
  const uuidCounterPath = join(directory, 'uuid-counter');
  const hostileEnvPath = join(directory, 'hostile.env');
  await mkdir(binDirectory);
  await writeFile(statePath, JSON.stringify({ container: false, volume: false }));
  await writeFile(hostileEnvPath,
    'DATABASE_URL=postgresql://hostile@127.0.0.1:59999/relay_test\n' +
    'RELAY_DRAFT_TEST_DATABASE_URL=postgresql://hostile@127.0.0.1:59999/relay_test\n');

  const dotenvConfig = JSON.stringify(join(repositoryRoot, 'node_modules/dotenv/dist/config.cjs'));

  await writeExecutable(join(binDirectory, 'docker'), `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.FAKE_VERIFY_LOG;
const statePath = process.env.FAKE_VERIFY_STATE;
appendFileSync(log, 'docker ' + args.join(' ') + '\\n');
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'));
const writeState = (state) => writeFileSync(statePath, JSON.stringify(state));
const fail = (message, code = 1) => { console.error(message); process.exit(code); };
if (args[0] === 'context' && args[1] === 'show') console.log('fake-context');
else if (args[0] === 'context' && args[1] === 'inspect')
  console.log(process.env.FAKE_DOCKER_ENDPOINT || 'unix:///tmp/fake-docker.sock');
else if (args[0] === 'info') process.exit(0);
else if (args[0] === 'run') {
  if (process.env.FAKE_DOCKER_RUN_FAIL === 'true') fail('forced docker run failure', 44);
  writeState({ container: true, volume: true });
  console.log('fake-container-id');
} else if (args[0] === 'port') console.log('127.0.0.1:55432');
else if (args[0] === 'exec') process.exit(0);
else if (args[0] === 'logs') console.error('fake container log');
else if (args[0] === 'container' && args[1] === 'rm') {
  const state = readState();
  if (!state.container) fail('Error response from daemon: No such container: ' + args.at(-1));
  state.container = false; writeState(state);
} else if (args[0] === 'volume' && args[1] === 'rm') {
  const state = readState();
  if (!state.volume) fail('Error response from daemon: get ' + args.at(-1) + ': no such volume');
  state.volume = false; writeState(state);
} else if ((args[0] === 'container' || args[0] === 'volume') && args[1] === 'inspect') {
  const state = readState(); const kind = args[0];
  if (process.env.FAKE_INSPECT_ERROR === 'true' && !state[kind])
    fail('permission denied while inspecting ' + kind);
  if (state[kind]) console.log(args.at(-1));
  else if (kind === 'container') fail('\\nError response from daemon: No such container: ' + args.at(-1));
  else fail('\\nError response from daemon: get ' + args.at(-1) + ': no such volume');
} else fail('unexpected docker command: ' + args.join(' '), 97);
`);

  const guardedChildPrelude = `
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const loadAndAssertGuardedEnvironment = () => {
  require(${dotenvConfig});
  const databaseUrl = new URL(process.env.DATABASE_URL || '');
  if (process.env.DATABASE_URL !== process.env.RELAY_DRAFT_TEST_DATABASE_URL ||
      databaseUrl.hostname !== '127.0.0.1' || databaseUrl.port !== '55432' ||
      databaseUrl.pathname !== '/relay_test' || !databaseUrl.username.startsWith('relay_verify_') ||
      databaseUrl.password === 'relay_verify_only' || databaseUrl.username === 'hostile' ||
      process.env.RELAY_TEST_DATABASE_DISPOSABLE !== 'true' ||
      process.env.DOTENV_PATH !== '/dev/null' || process.env.DOTENV_OVERRIDE !== 'false' ||
      process.env.DOTENV_CONFIG_PATH !== '/dev/null' || process.env.DOTENV_CONFIG_OVERRIDE !== 'false') {
    console.error('verification child environment was not pinned'); process.exit(90);
  }
};
`;

  await writeExecutable(join(binDirectory, 'node'), `#!${process.execPath}
${guardedChildPrelude}
if (args[0] === '-e') {
  let count = 0;
  try { count = Number(readFileSync(process.env.FAKE_UUID_COUNTER, 'utf8')); } catch {}
  count += 1; writeFileSync(process.env.FAKE_UUID_COUNTER, String(count));
  const ids = ['11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  process.stdout.write(ids[count - 1] || ids[2]); process.exit(0);
}
loadAndAssertGuardedEnvironment();
appendFileSync(process.env.FAKE_VERIFY_LOG, JSON.stringify({ command: 'node', args,
  databaseUrl: process.env.DATABASE_URL, draftUrl: process.env.RELAY_DRAFT_TEST_DATABASE_URL,
  databaseUser: process.env.RELAY_VERIFY_DATABASE_USER,
  ownershipNonce: process.env.RELAY_VERIFY_OWNERSHIP_NONCE }) + '\\n');
if (args.includes('scripts/check-verification-database.ts') && process.env.FAKE_OWNERSHIP_FAIL === 'true') {
  console.error('verification database ownership mismatch'); process.exit(41);
}
`);

  await writeExecutable(join(binDirectory, 'npm'), `#!${process.execPath}
${guardedChildPrelude}
loadAndAssertGuardedEnvironment();
appendFileSync(process.env.FAKE_VERIFY_LOG, JSON.stringify({ command: 'npm', args,
  databaseUrl: process.env.DATABASE_URL, draftUrl: process.env.RELAY_DRAFT_TEST_DATABASE_URL }) + '\\n');
if (process.env.FAKE_NPM_FAIL_COMMAND === args.join(' ')) {
  console.error('forced npm failure'); process.exit(Number(process.env.FAKE_NPM_EXIT || '42'));
}
`);

  return {
    directory, logPath, statePath,
    run(overrides = {}) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
        FAKE_VERIFY_LOG: logPath, FAKE_VERIFY_STATE: statePath,
        FAKE_UUID_COUNTER: uuidCounterPath,
        DOTENV_PATH: hostileEnvPath, DOTENV_OVERRIDE: 'true',
        DOTENV_CONFIG_PATH: hostileEnvPath, DOTENV_CONFIG_OVERRIDE: 'true',
        ...overrides,
      };
      delete env.DOCKER_HOST; delete env.DOCKER_CONTEXT;
      if (overrides.DOCKER_HOST !== undefined) env.DOCKER_HOST = overrides.DOCKER_HOST;
      if (overrides.DOCKER_CONTEXT !== undefined) env.DOCKER_CONTEXT = overrides.DOCKER_CONTEXT;
      return spawnSync('bash', ['scripts/verify.sh'], {
        cwd: repositoryRoot, env, encoding: 'utf8', timeout: 15_000,
      });
    },
  };
}

async function readFakeLog(fake: FakeVerification) {
  try { return await readFile(fake.logPath, 'utf8'); } catch { return ''; }
}

test('repository verification retains its required static workflow boundaries', async () => {
  const [packageJson, script] = await Promise.all([
    readRepositoryFile('package.json'), readRepositoryFile('scripts/verify.sh'),
  ]);
  assert.equal(JSON.parse(packageJson).scripts.verify, 'bash scripts/verify.sh');
  assert.match(script, /pgvector\/pgvector:0\.8\.1-pg14/);
  assert.match(script, /--publish 127\.0\.0\.1::5432/);
  assert.match(script, /POSTGRES_DB=relay_test/);
  assert.match(script, /scripts\/check-test-database\.ts/);
  assert.match(script, /scripts\/check-verification-database\.ts/);
  assert.match(script, /migration_files=\(migrations\/\*\.sql\)/);
  assert.match(script, /npm run typecheck/);
  assert.match(script, /npm test/);
});

test('verification rejects a non-local Docker endpoint before creating resources', async () => {
  const fake = await createFakeVerification();
  try {
    const result = fake.run({
      DOCKER_CONTEXT: 'remote-builder',
      DOCKER_HOST: 'unix:///tmp/misleading-local.sock',
      FAKE_DOCKER_ENDPOINT: 'ssh://builder.example.test',
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /local Unix socket/);
    assert.doesNotMatch(await readFakeLog(fake), /^docker run /m);
  } finally { await rm(fake.directory, { recursive: true, force: true }); }
});

test('database ownership requires the exact per-run role, database, and nonce', () => {
  const expected = {
    database_user: 'relay_verify_run',
    database_name: 'relay_test',
    ownership_nonce: 'run-nonce',
  };
  assert.doesNotThrow(() => assertVerificationDatabaseOwnership(expected,
    expected.database_user, expected.ownership_nonce));
  assert.throws(() => assertVerificationDatabaseOwnership(
    { ...expected, database_user: 'other_user' }, expected.database_user, expected.ownership_nonce));
  assert.throws(() => assertVerificationDatabaseOwnership(
    { ...expected, database_name: 'other_database' }, expected.database_user, expected.ownership_nonce));
  assert.throws(() => assertVerificationDatabaseOwnership(
    { ...expected, ownership_nonce: 'other_nonce' }, expected.database_user, expected.ownership_nonce));
  assert.throws(() => assertVerificationDatabaseOwnership(undefined,
    expected.database_user, expected.ownership_nonce));
});

test('hostile dotenv settings cannot replace generated database URLs in verification children', async () => {
  const fake = await createFakeVerification();
  try {
    const result = fake.run();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const log = await readFakeLog(fake);
    assert.doesNotMatch(log, /postgresql:\/\/hostile/);
    assert.match(log, /scripts\/check-test-database\.ts/);
    assert.match(log, /scripts\/check-verification-database\.ts/);
    assert.match(log, /migrations\/001_create_prospects\.sql/);
    assert.match(log, /"command":"npm","args":\["test"\]/);
    assert.deepEqual(JSON.parse(await readFile(fake.statePath, 'utf8')),
      { container: false, volume: false });
  } finally { await rm(fake.directory, { recursive: true, force: true }); }
});

test('an unowned database is rejected before migrations or tests can run', async () => {
  const fake = await createFakeVerification();
  try {
    const result = fake.run({ FAKE_OWNERSHIP_FAIL: 'true' });
    assert.equal(result.status, 41, `${result.stdout}\n${result.stderr}`);
    const log = await readFakeLog(fake);
    const guardIndex = log.indexOf('scripts/check-test-database.ts');
    const ownershipIndex = log.indexOf('scripts/check-verification-database.ts');
    assert.ok(guardIndex >= 0 && ownershipIndex > guardIndex);
    assert.doesNotMatch(log, /migrations\//);
    assert.doesNotMatch(log, /"command":"npm"/);
    assert.deepEqual(JSON.parse(await readFile(fake.statePath, 'utf8')),
      { container: false, volume: false });
  } finally { await rm(fake.directory, { recursive: true, force: true }); }
});

test('a forced verification failure still removes its container and volume', async () => {
  const fake = await createFakeVerification();
  try {
    const result = fake.run({ FAKE_NPM_FAIL_COMMAND: 'run typecheck', FAKE_NPM_EXIT: '42' });
    assert.equal(result.status, 42, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(await readFile(fake.statePath, 'utf8')),
      { container: false, volume: false });
  } finally { await rm(fake.directory, { recursive: true, force: true }); }
});

test('cleanup accepts explicit not-found evidence while preserving setup failure', async () => {
  const fake = await createFakeVerification();
  try {
    const result = fake.run({ FAKE_DOCKER_RUN_FAIL: 'true' });
    assert.equal(result.status, 44, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /could not verify.*absence/);
  } finally { await rm(fake.directory, { recursive: true, force: true }); }
});

test('cleanup inspection errors make an otherwise successful verification fail', async () => {
  const fake = await createFakeVerification();
  try {
    const result = fake.run({ FAKE_INSPECT_ERROR: 'true' });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /could not verify.*absence/);
  } finally { await rm(fake.directory, { recursive: true, force: true }); }
});

test('cleanup failure is surfaced without replacing the original verification failure', async () => {
  const fake = await createFakeVerification();
  try {
    const result = fake.run({
      FAKE_NPM_FAIL_COMMAND: 'run typecheck', FAKE_NPM_EXIT: '42', FAKE_INSPECT_ERROR: 'true',
    });
    assert.equal(result.status, 42, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /could not verify.*absence/);
  } finally { await rm(fake.directory, { recursive: true, force: true }); }
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
