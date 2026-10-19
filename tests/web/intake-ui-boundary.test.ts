import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const SPECIFIER = /\b(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

// Static import closure of a module, read from source without executing it.
function importClosure(entry: string): { modules: string[]; packages: string[] } {
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
      const target = new URL(specifier!.replace(/\.js$/, ".ts"), new URL(path, `file://${root}`));
      pending.push(relative(root, fileURLToPath(target)));
    }
  }
  return { modules: [...modules].sort(), packages: [...packages].sort() };
}

test("Intake UI process loads only intake, page, and database modules: no provider code", () => {
  const { modules, packages } = importClosure("scripts/run-intake-ui.ts");
  assert.deepEqual(modules, [
    "scripts/run-intake-ui.ts",
    "src/db.ts",
    "src/intake/prospect-intake.ts",
    "src/outreach/types/prospect-stages.ts",
    "src/research/research-evidence.ts",
    "src/web/intake-pages.ts",
    "src/web/intake-server.ts",
  ]);
  assert.deepEqual(packages, ["dotenv/config", "node:crypto", "node:http", "node:net", "pg"]);
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
  assert.doesNotMatch(result.stderr, /RELAY_INTAKE_UI_PORT|invalid-secret-port/);
});
