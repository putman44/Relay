export const EVAL_SITES = [
  "relay",
  "hvac",
  "restaurant",
  "counseling",
] as const;

export const OPENAI_OPT_IN_FLAG = "--allow-openai";

export type EvalArgs = {
  site: string;
  // `--name` arguments.
  flags: Set<string>;
  // `--name=value` arguments.
  options: Map<string, string>;
};

// `<site> [--flag] [--name=value]`. The site defaults to "relay".
export function parseEvalArgs(
  argv: string[],
  allowedSites: readonly string[] = EVAL_SITES,
): EvalArgs {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positional: string[] = [];

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const separator = arg.indexOf("=");

    if (separator === -1) {
      flags.add(arg);
    } else {
      options.set(arg.slice(0, separator), arg.slice(separator + 1));
    }
  }

  const site = positional[0] ?? "relay";

  if (!allowedSites.includes(site)) {
    throw new Error(`Site must be one of: ${allowedSites.join(", ")}.`);
  }

  return { site, flags, options };
}

// Live OpenAI evaluation runners send captured website content to a paid
// provider. They must be authorized explicitly for each invocation: never
// by credentials, `.env`, or the environment. Call this before reading
// fixtures or opening a connection.
export function requireOpenAiOptIn(flags: ReadonlySet<string>) {
  if (!flags.has(OPENAI_OPT_IN_FLAG)) {
    throw new Error(
      "This runner sends captured website content to OpenAI and incurs " +
        "usage costs. Nothing was sent. Re-run with " +
        `${OPENAI_OPT_IN_FLAG} only when this specific run is authorized.`,
    );
  }
}

export type Decision = {
  blockId: number;
  action: "keep" | "drop";
  category: string;
  relatedBlockIds: number[];
  note: string;
};

// Every block needs exactly one decision, and every reference must point at
// a real block.
export function validateDecisions(
  blocks: ReadonlyArray<{ id: number }>,
  decisions: unknown,
): asserts decisions is Decision[] {
  if (!Array.isArray(decisions)) {
    throw new Error("AI returned no decisions array.");
  }

  const validIds = new Set(blocks.map((block) => block.id));
  const seen = new Set<number>();

  for (const decision of decisions as Decision[]) {
    if (
      !validIds.has(decision.blockId) ||
      seen.has(decision.blockId) ||
      !Array.isArray(decision.relatedBlockIds) ||
      decision.relatedBlockIds.some((id) => !validIds.has(id))
    ) {
      throw new Error("AI returned invalid block references.");
    }

    seen.add(decision.blockId);
  }

  if (seen.size !== blocks.length) {
    throw new Error("AI did not classify every block.");
  }
}

// Optional diagnostics: print the decisions for blocks whose text matches
// `--highlight=<regex>`. Site-specific patterns stay out of the repository.
export function printHighlights(
  blocks: ReadonlyArray<{ id: number; text: string }>,
  decisions: readonly Decision[],
  pattern: string | undefined,
) {
  if (!pattern) return;

  const matcher = new RegExp(pattern, "i");
  const ids = new Set(
    blocks
      .filter((block) => matcher.test(block.text))
      .slice(0, 12)
      .map((block) => block.id),
  );

  console.log("\nHighlighted decisions:");
  console.log(
    JSON.stringify(
      decisions.filter((item) => ids.has(item.blockId)),
      null,
      2,
    ),
  );
}
