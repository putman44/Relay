import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  OPENAI_OPT_IN_FLAG,
  parseEvalArgs,
  requireOpenAiOptIn,
  validateDecisions,
} from "../../evals/eval-common.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test("Evaluation arguments default to the relay site", () => {
  const { site, flags, options } = parseEvalArgs([]);

  assert.equal(site, "relay");
  assert.equal(flags.size, 0);
  assert.equal(options.size, 0);
});

test("Evaluation arguments separate flags, options, and the site", () => {
  const { site, flags, options } = parseEvalArgs([
    "--allow-openai",
    "restaurant",
    "--highlight=sale|discount",
  ]);

  assert.equal(site, "restaurant");
  assert.ok(flags.has("--allow-openai"));
  assert.equal(options.get("--highlight"), "sale|discount");
});

test("Evaluation arguments reject sites outside the allowed list", () => {
  assert.throws(() => parseEvalArgs(["unknown"]), /Site must be one of/);
  assert.throws(
    () => parseEvalArgs(["restaurant"], ["relay", "hvac"]),
    /Site must be one of: relay, hvac/,
  );
});

test("Live OpenAI runs require the explicit opt-in flag", () => {
  assert.throws(
    () => requireOpenAiOptIn(new Set()),
    /Nothing was sent[\s\S]*--allow-openai/,
  );

  // Near misses are not authorization.
  assert.throws(() => requireOpenAiOptIn(new Set(["--allow-openai=true"])));
  assert.throws(() => requireOpenAiOptIn(new Set(["--allow-openia"])));
  assert.throws(() => requireOpenAiOptIn(new Set(["allow-openai"])));

  assert.doesNotThrow(() => requireOpenAiOptIn(new Set([OPENAI_OPT_IN_FLAG])));
});

test("Credentials in the environment are not authorization", () => {
  const previous = {
    key: process.env.OPENAI_API_KEY,
    model: process.env.RELAY_RESEARCH_MODEL,
  };

  process.env.OPENAI_API_KEY = "test-key-not-real";
  process.env.RELAY_RESEARCH_MODEL = "test-model";

  try {
    assert.throws(() => requireOpenAiOptIn(parseEvalArgs([]).flags));
  } finally {
    for (const [name, value] of [
      ["OPENAI_API_KEY", previous.key],
      ["RELAY_RESEARCH_MODEL", previous.model],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

for (const runner of ["run-ai.ts", "run-ai-v2.ts"]) {
  test(`${runner} refuses to run without the opt-in flag`, () => {
    // The environment holds no credentials and cannot load a `.env`, so
    // even a missing guard could not reach the network from here.
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", `evals/${runner}`, "relay"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: process.env.PATH ?? "",
          DOTENV_CONFIG_PATH: "/nonexistent/relay-eval-guard-test.env",
          DOTENV_CONFIG_QUIET: "true",
        },
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Nothing was sent/);
    assert.match(result.stderr, /--allow-openai/);
    assert.doesNotMatch(result.stdout, /AI decisions/);
  });
}

test("AI decisions must cover every block exactly once", () => {
  const blocks = [{ id: 0 }, { id: 1 }];
  const decision = (blockId: number, relatedBlockIds: number[] = []) => ({
    blockId,
    action: "keep",
    category: "other",
    relatedBlockIds,
    note: "",
  });

  assert.doesNotThrow(() =>
    validateDecisions(blocks, [decision(0, [1]), decision(1)]),
  );

  assert.throws(() => validateDecisions(blocks, "nope"), /no decisions array/);
  assert.throws(
    () => validateDecisions(blocks, [decision(0)]),
    /did not classify every block/,
  );
  assert.throws(
    () => validateDecisions(blocks, [decision(0), decision(0), decision(1)]),
    /invalid block references/,
  );
  assert.throws(
    () => validateDecisions(blocks, [decision(0), decision(7)]),
    /invalid block references/,
  );
  assert.throws(
    () => validateDecisions(blocks, [decision(0, [9]), decision(1)]),
    /invalid block references/,
  );
});
