import { strict as assert } from 'node:assert';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repositoryRootUrl = new URL('../../', import.meta.url);

async function readRepositoryFile(path: string) {
  return readFile(new URL(path, repositoryRootUrl), 'utf8');
}

test('relay-plan requires explicit invocation and uses the canonical Claude symlink', async () => {
  const [skill, openAiConfig] = await Promise.all([
    readRepositoryFile('.agents/skills/relay-plan/SKILL.md'),
    readRepositoryFile('.agents/skills/relay-plan/agents/openai.yaml'),
  ]);
  const claudeSkillPath = fileURLToPath(new URL('.claude/skills/relay-plan', repositoryRootUrl));

  assert.match(skill, /^name: relay-plan$/m);
  assert.match(skill, /^disable-model-invocation: true$/m);
  assert.match(openAiConfig, /^  allow_implicit_invocation: false$/m);
  assert.equal((await lstat(claudeSkillPath)).isSymbolicLink(), true);
  assert.equal(await readlink(claudeSkillPath), '../../.agents/skills/relay-plan');
});

test('relay-plan keeps the issue authoritative and has the required output contract', async () => {
  const skill = await readRepositoryFile('.agents/skills/relay-plan/SKILL.md');

  assert.match(skill, /issue body as the authoritative approved scope/i);
  assert.match(skill, /comments?.*only when the user explicitly confirms/i);
  assert.match(skill, /state the issue number and title/i);
  assert.match(skill, /repository evidence.*remembered behavior/i);
  assert.match(skill, /Required by the issue/);
  assert.match(skill, /Derived from repository evidence/);
  assert.match(skill, /Requires human decision/);
  assert.match(skill, /material.*unresolved.*`BLOCKED`/i);

  for (const heading of [
    'Issue',
    'Plan status',
    'Goal',
    'Approved scope',
    'Relevant repository evidence',
    'Affected areas',
    'Implementation steps',
    'Verification plan',
    'Relay safety constraints',
    'Human decisions required',
    'Out of scope',
    'Risks and assumptions',
  ]) {
    assert.match(skill, new RegExp(`\\*\\*${heading}\\*\\*`));
  }
  assert.match(skill, /`READY` or `BLOCKED`/);
});

test('relay-plan avoids secret-bearing local files and redacts sensitive output', async () => {
  const skill = await readRepositoryFile('.agents/skills/relay-plan/SKILL.md');

  assert.match(skill, /do not read.*\.env/i);
  assert.match(skill, /credential files.*tokens.*private keys/i);
  assert.match(skill, /ignored.*local configuration/i);
  assert.match(skill, /checked-in configuration examples.*source code.*documentation/i);
  assert.match(skill, /redact.*secrets.*credentials.*PII.*sensitive values/i);
  assert.match(skill, /planner output.*must not include.*secret values/i);
  assert.match(skill, /continue.*read-only inspection/i);
});

test('relay-plan is read-only and leaves implementation and review as separate roles', async () => {
  const [skill, agents, issueTracker] = await Promise.all([
    readRepositoryFile('.agents/skills/relay-plan/SKILL.md'),
    readRepositoryFile('AGENTS.md'),
    readRepositoryFile('docs/agents/issue-tracker.md'),
  ]);

  assert.match(skill, /strictly read-only/i);
  assert.match(skill, /create, modify, delete, rename, or reformat repository files/i);
  assert.match(skill, /stage, commit, push, fetch, merge, rebase, switch branches, stash, reset, or clean/i);
  assert.match(skill, /create, edit, comment on, label, assign, close, or otherwise mutate GitHub/i);
  assert.match(skill, /run migrations/i);
  assert.match(skill, /run database-writing tests/i);
  assert.match(skill, /invoke `npm run verify`/i);
  assert.match(skill, /Gmail, Google Drive, Firecrawl, OpenAI/i);
  assert.match(skill, /workers, schedulers, operator mutations/i);
  assert.match(skill, /invoke `relay-implement` or `relay-review`/i);

  assert.match(agents, /Route read-only issue-driven planning work to `relay-plan`/);
  assert.match(agents, /Route implementation work to `relay-implement`/);
  assert.match(agents, /Route independent review work to `relay-review`/);
  assert.match(issueTracker, /may invoke `relay-plan`/);
  assert.match(issueTracker, /issue remains the authoritative scope/i);
  assert.match(issueTracker, /invokes `relay-implement`/);
  assert.match(issueTracker, /invokes `relay-review` independently/i);
});
