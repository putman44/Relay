import { strict as assert } from 'node:assert';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repositoryRootUrl = new URL('../../', import.meta.url);

async function readRepositoryFile(path: string) {
  return readFile(new URL(path, repositoryRootUrl), 'utf8');
}

const compactHeadings = [
  'Issue', 'Plan status', 'Implementation guidance', 'Affected files',
  'Verification', 'Human decisions required', 'Risks',
];
const handoffHeadings = [
  'Issue', 'Plan status', 'Goal', 'Approved scope', 'Relevant repository evidence',
  'Affected areas', 'Implementation steps', 'Verification plan',
  'Relay safety constraints', 'Human decisions required', 'Out of scope',
  'Risks and assumptions',
];

function numberedHeadings(section: string) {
  return [...section.matchAll(/^\d+\. \*\*(.+?)\*\*/gm)].map((match) => match[1]);
}

function example(skill: string, label: string) {
  const match = skill.match(new RegExp(`Representative ${label} output[^\\n]*:\\n\\n\\x60{3}text\\n([\\s\\S]*?)\\n\\x60{3}`));
  assert.ok(match, `${label} example is present`);
  return match[1]!;
}

function outputHeadings(output: string) {
  return [...output.matchAll(/^\*\*(.+?)\*\*:/gm)].map((match) => match[1]);
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

test('relay-plan selects one mode and preserves both section contracts', async () => {
  const skill = await readRepositoryFile('.agents/skills/relay-plan/SKILL.md');
  const compact = skill.split('### COMPACT (default)\n')[1]?.split('### HANDOFF ')[0];
  const handoff = skill.split('### HANDOFF ')[1]?.split('Use `READY` only')[0];
  assert.ok(compact);
  assert.ok(handoff);

  assert.match(skill, /COMPACT by default.*Select HANDOFF only when.*`Output mode: HANDOFF`/);
  assert.match(skill, /Emit only the selected report; never emit both modes/);
  assert.match(compact, /Target no more than 200 words.*soft target/);
  assert.match(compact, /never omit or truncate blockers, unresolved human decisions, meaningful risks, or safety conflicts/);
  assert.match(compact, /Use `None` for Human decisions required or Risks/);
  assert.match(compact, /Do not repeat the issue body, general repository rules, or standard Relay safety boilerplate/);
  assert.deepEqual(numberedHeadings(compact), compactHeadings);
  assert.deepEqual(numberedHeadings(handoff), handoffHeadings);
  assert.match(skill, /Both modes use \*\*Plan status\*\* with exactly `READY` or `BLOCKED`/);
  assert.match(skill, /Apply the same blocking rules below in either mode/);
  assert.match(skill, /material unresolved decision makes the plan `BLOCKED`/);
  assert.match(skill, /HANDOFF must name every applicable safety boundary and provide repository-supported affected areas precise enough to derive an exact changed-path allowlist/);
});

test('relay-plan representative reports have exact status syntax and one mode each', async () => {
  const skill = await readRepositoryFile('.agents/skills/relay-plan/SKILL.md');
  const ready = example(skill, 'COMPACT READY');
  const blocked = example(skill, 'COMPACT BLOCKED');
  const handoff = example(skill, 'HANDOFF');

  for (const [output, headings, status] of [
    [ready, compactHeadings, 'READY'],
    [blocked, compactHeadings, 'BLOCKED'],
    [handoff, handoffHeadings, 'READY'],
  ] as const) {
    assert.deepEqual(outputHeadings(output), headings);
    assert.match(output, new RegExp(`^\\*\\*Plan status\\*\\*: ${status}$`, 'm'));
    assert.equal([...output.matchAll(/^\*\*Plan status\*\*:/gm)].length, 1);
  }
  assert.ok(ready.trim().split(/\s+/).length <= 200);
  assert.ok(blocked.trim().split(/\s+/).length <= 200);
  assert.match(ready, /^\*\*Human decisions required\*\*: None$/m);
  assert.match(ready, /^\*\*Risks\*\*: None$/m);
  assert.match(blocked, /^\*\*Human decisions required\*\*: Approve the retention period/m);
  assert.match(blocked, /Hold implementation until the retention period is approved/);
  assert.match(handoff, /^\*\*Affected areas\*\*: src\/summary\.ts; tests\/summary\.test\.ts\.$/m);
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

  assert.match(agents, /`relay-plan`, `relay-implement`, and `relay-review` skills remain available for explicit use/);
  assert.match(agents, /External engineering tools may work on Relay when the user requests them/);
  assert.match(agents, /An implementing agent does not review its own work/);
  assert.match(issueTracker, /may invoke `relay-plan`/);
  assert.match(issueTracker, /approved scope remains authoritative/i);
  assert.match(issueTracker, /`relay-implement` for implementation/);
  assert.match(issueTracker, /`relay-review` for independent review/);
});
