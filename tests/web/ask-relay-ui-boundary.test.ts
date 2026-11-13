import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DemoDatabaseError,
  requireDemoDatabaseUrl,
} from "../../src/data/demo-database.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
// Import and re-export statements and dynamic imports. Type-only imports are
// erased before running, so they are skipped: this is what the process loads.
const IMPORT =
  /^\s*(?:import|export)\s+(type\s)?[^;]*?\bfrom\s*["']([\w@./:-]+)["']|^\s*import\s*["']([\w@./:-]+)["']|\bimport\s*\(\s*["']([\w@./:-]+)["']\s*\)/gm;

function runtimeImports(entry: string): { modules: string[]; packages: string[] } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  while (pending.length) {
    const path = pending.pop()!;
    if (modules.has(path)) continue;
    modules.add(path);
    const source = readFileSync(`${root}${path}`, "utf8");
    for (const [, typeOnly, from, bare, dynamic] of source.matchAll(IMPORT)) {
      if (typeOnly) continue;
      const specifier = (from ?? bare ?? dynamic)!;
      if (!specifier.startsWith(".")) {
        packages.add(specifier);
        continue;
      }
      const target = new URL(specifier.replace(/\.js$/, ".ts"), new URL(path, `file://${root}`));
      pending.push(relative(root, fileURLToPath(target)));
    }
  }
  return { modules: [...modules].sort(), packages: [...packages].sort() };
}

test("The demo database guard accepts only a loopback database named relay_demo", () => {
  for (const url of [
    "postgresql://relay_demo:relay_demo@127.0.0.1:55652/relay_demo",
    "postgres://relay_demo@localhost/relay_demo",
    "postgresql://relay_demo@[::1]:5432/relay_demo",
  ])
    assert.equal(requireDemoDatabaseUrl(url), url);

  for (const url of [
    undefined,
    "",
    "not a url",
    "postgresql://owner:secret@ep-example-123.us-east-2.aws.neon.tech/neondb",
    "postgresql://owner:secret@ep-example-123.us-east-2.aws.neon.tech/relay_demo",
    "postgresql://u:p@127.0.0.1:5432/relay_test",
    "postgresql://u:p@127.0.0.1:5432/neondb",
    "postgresql://u:p@127.0.0.1:5432/relay_demo_copy",
    "postgresql://u:p@10.0.0.5:5432/relay_demo",
    // pg would connect to the query-string host, not the URL host.
    "postgresql://u:p@127.0.0.1:5432/relay_demo?host=evil.example.com",
    "postgresql://u:p@127.0.0.1:5432/relay_demo?host=/var/run/postgresql",
    "mysql://u:p@127.0.0.1:3306/relay_demo",
  ])
    assert.throws(() => requireDemoDatabaseUrl(url), DemoDatabaseError);
});

test("The Ask Relay UI refuses to start against any database but the demo one", () => {
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  delete environment.OPENAI_API_KEY;
  delete environment.RELAY_RESEARCH_MODEL;
  for (const databaseUrl of [
    "postgresql://owner:secret-pass@ep-example-123.us-east-2.aws.neon.tech/neondb",
    "postgresql://u:p@127.0.0.1:5432/relay_test",
    "postgresql://u:p@127.0.0.1:5432/relay_demo?host=evil.example.com",
    undefined,
  ]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", `${root}scripts/run-ask-relay-ui.ts`], {
      cwd: root,
      encoding: "utf8",
      // .env is never read, so the case without DATABASE_URL really has none.
      env: {
        ...environment,
        DOTENV_CONFIG_PATH: "/dev/null",
        DOTENV_CONFIG_QUIET: "true",
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      },
      timeout: 10000,
    });
    assert.equal(result.status, 1, `expected refusal for ${databaseUrl}`);
    assert.match(result.stderr, /Ask Relay UI did not start\. .*loopback database named relay_demo/);
    assert.doesNotMatch(result.stderr, /secret-pass|neon\.tech|evil\.example/);
    assert.doesNotMatch(result.stdout, /listening/);
  }
});

test("The Ask Relay UI process loads only Ask Relay, page, and pg modules: never .env's database pool, Gmail, Drive, Firecrawl, or workers", () => {
  const { modules, packages } = runtimeImports("scripts/run-ask-relay-ui.ts");
  assert.deepEqual(modules, [
    "scripts/run-ask-relay-ui.ts",
    "src/data/demo-database.ts",
    "src/data/research-embeddings.ts",
    "src/research/ask-relay.ts",
    "src/research/openai-answerer.ts",
    "src/research/openai-embeddings.ts",
    "src/research/research-chunker.ts",
    "src/web/ask-relay-pages.ts",
    "src/web/ask-relay-server.ts",
    "src/web/intake-pages.ts",
  ]);
  assert.deepEqual(packages, ["dotenv/config", "node:crypto", "node:http", "pg"]);
});
