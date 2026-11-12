import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
// Specifier characters only, so quoted text after an ordinary "from" in code is not read as an import.
const SPECIFIER = /\b(?:from\s*|import\s*\(\s*|import\s+)["']([\w@./:-]+)["']/g;

// Static import closure of a module, read from source without executing it.
function importClosure(entry: string): {
  modules: string[];
  packages: string[];
} {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  while (pending.length) {
    const path = pending.pop()!;
    if (modules.has(path)) continue;
    modules.add(path);
    const source = readFileSync(`${root}${path}`, "utf8");
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      if (!specifier!.startsWith(".")) {
        packages.add(specifier!);
        continue;
      }
      const target = new URL(
        specifier!.replace(/\.js$/, ".ts"),
        new URL(path, `file://${root}`),
      );
      pending.push(relative(root, fileURLToPath(target)));
    }
  }
  return { modules: [...modules].sort(), packages: [...packages].sort() };
}

test("Intake UI process loads only intake, page, database, and research modules: no Gmail runtime, sender, or worker code", () => {
  const { modules, packages } = importClosure("scripts/run-intake-ui.ts");
  // Start Research needs the research workflow with its Firecrawl, OpenAI, and Drive providers.
  // The Gmail entries are the OAuth client Drive shares and modules reached only through type imports.
  assert.deepEqual(modules, [
    "scripts/run-intake-ui.ts",
    "src/db.ts",
    "src/gmail/gmail-auth.ts",
    "src/gmail/gmail-draft-creator.ts",
    "src/gmail/gmail-message-reader.ts",
    "src/intake/prospect-intake.ts",
    "src/outreach/outreach-draft-content.ts",
    "src/outreach/reply-context.ts",
    "src/outreach/types/prospect-stages.ts",
    "src/research/drive-artifacts.ts",
    "src/research/firecrawl-scraper.ts",
    "src/research/openai-researcher.ts",
    "src/research/prospect-research.ts",
    "src/research/research-evidence.ts",
    "src/research/research-result.ts",
    "src/web/intake-pages.ts",
    "src/web/intake-research.ts",
    "src/web/intake-server.ts",
  ]);
  // Nothing that builds a Gmail client for drafts or sending, and no job or worker code, may be reachable.
  assert.deepEqual(
    modules.filter((path) =>
      /gmail-runtime|sender|^src\/jobs\/|worker/.test(path),
    ),
    [],
  );
  assert.deepEqual(packages, [
    "dotenv/config",
    "googleapis",
    "node:crypto",
    "node:http",
    "node:net",
    "node:stream",
    "pg",
    "postal-mime",
  ]);
});

test("Intake UI process hides unexpected startup error details", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", `${root}scripts/run-intake-ui.ts`],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        DOTENV_CONFIG_QUIET: "true",
        RELAY_INTAKE_UI_PORT: "invalid-secret-port",
      },
      timeout: 5000,
    },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "Relay intake UI failed to start.");
  assert.doesNotMatch(
    result.stderr,
    /RELAY_INTAKE_UI_PORT|invalid-secret-port/,
  );
});
