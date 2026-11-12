import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const repositoryRootUrl = new URL("../../", import.meta.url);

async function readRepositoryFile(path: string) {
  return readFile(new URL(path, repositoryRootUrl), "utf8");
}

test("relay-review retains its human-readable independent three-axis report", async () => {
  const skill = await readRepositoryFile(
    ".agents/skills/relay-review/SKILL.md",
  );

  assert.match(skill, /\*\*Spec\*\*/);
  assert.match(skill, /\*\*Relay Safety\*\*/);
  assert.match(skill, /\*\*Standards\*\*/);
  assert.match(skill, /Keep their reasoning separate/i);
  assert.match(skill, /strictly read-only/i);
});
