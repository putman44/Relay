import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const repositoryRootUrl = new URL('../../', import.meta.url);

async function readRepositoryFile(path: string) {
  return readFile(new URL(path, repositoryRootUrl), 'utf8');
}

test('relay-review retains its human-readable independent three-axis report', async () => {
  const skill = await readRepositoryFile('.agents/skills/relay-review/SKILL.md');

  assert.match(skill, /\*\*Spec\*\*/);
  assert.match(skill, /\*\*Relay Safety\*\*/);
  assert.match(skill, /\*\*Standards\*\*/);
  assert.match(skill, /Keep their reasoning separate/i);
  assert.match(skill, /strictly read-only/i);
});

test('relay-review emits a stable machine-readable continuation result', async () => {
  const skill = await readRepositoryFile('.agents/skills/relay-review/SKILL.md');

  assert.match(skill, /machine-readable.*JSON/is);
  assert.match(skill, /"schemaVersion"/);
  assert.match(skill, /"recommendation"/);
  assert.match(skill, /MERGE.*CHANGES.*FURTHER_DESIGN_REVIEW/is);
  assert.match(skill, /"reviewedBaseSha"/);
  assert.match(skill, /"reviewedHeadSha"/);
  assert.match(skill, /"blockingDefectCount"/);
  assert.match(skill, /"requiredVerification"/);
  assert.match(skill, /SUCCESS.*INCOMPLETE.*FAILED/is);
  assert.match(skill, /valid JSON/i);
});

test('relay-review allows continuation only for matching, fully verified MERGE evidence', async () => {
  const skill = await readRepositoryFile('.agents/skills/relay-review/SKILL.md');

  assert.match(skill, /recommendation.*exactly `MERGE`/i);
  assert.match(skill, /blocking defect count.*zero/i);
  assert.match(skill, /required verification.*`SUCCESS`/i);
  assert.match(skill, /reviewed base SHA.*reviewed HEAD SHA.*exactly match/is);
  assert.match(skill, /otherwise.*STOP/i);
});
