import { readFile, writeFile } from "node:fs/promises";

import { BLOCK_CATEGORIES } from "./chunk-engine.js";
import { parseEvalArgs } from "./eval-common.js";

const { site } = parseEvalArgs(process.argv.slice(2));

const filename = `${site}-page`;

const baseline = JSON.parse(
  await readFile(`evals/results/${filename}.deterministic.json`, "utf8"),
) as {
  sourceUrl: string;
  blocks: Array<{ id: number; type: string; text: string }>;
};

const ai = JSON.parse(
  await readFile(`evals/results/${filename}.ai-v2.json`, "utf8"),
) as {
  decisions: Array<{
    blockId: number;
    action: "keep" | "drop";
    category: string;
    relatedBlockIds: number[];
  }>;
};

const decisions = new Map(
  ai.decisions.map((decision) => [decision.blockId, decision]),
);

const seenNavigation = new Set<string>();

const blocks = baseline.blocks.map((block) => {
  const decision = decisions.get(block.id);

  if (!decision) {
    throw new Error(`Missing AI decision for block ${block.id}`);
  }

  if (!(BLOCK_CATEGORIES as readonly string[]).includes(decision.category)) {
    throw new Error(
      `Unknown category "${decision.category}" for block ${block.id}.`,
    );
  }

  const text = block.text.trim();

  // Conservative, deterministic interface-noise rules.
  const obviousNoise =
    /^Read more$/i.test(text) ||
    /^```$/.test(text) ||
    /^\d+\.\s+\d{2}$/.test(text);

  let retrievalRole: "primary" | "context" | "excluded";

  if (obviousNoise || decision.action === "drop") {
    retrievalRole = "excluded";
  } else if (decision.category === "navigation") {
    // Keep the first copy available as context.
    if (seenNavigation.has(text)) {
      retrievalRole = "excluded";
    } else {
      seenNavigation.add(text);
      retrievalRole = "context";
    }
  } else if (
    [
      "customer_review",
      "manufacturer_claim",
      "fictional_demo",
      "form_ui",
    ].includes(decision.category) ||
    /^!\[/.test(text)
  ) {
    retrievalRole = "context";
  } else {
    retrievalRole = "primary";
  }

  return {
    id: block.id,
    category: decision.category,
    retrievalRole,
    relatedBlockIds: decision.relatedBlockIds,
    text: block.text,
  };
});

const counts = {
  primary: blocks.filter((b) => b.retrievalRole === "primary").length,
  context: blocks.filter((b) => b.retrievalRole === "context").length,
  excluded: blocks.filter((b) => b.retrievalRole === "excluded").length,
};

await writeFile(
  `evals/results/${filename}.hybrid.json`,
  JSON.stringify({ sourceUrl: baseline.sourceUrl, counts, blocks }, null, 2),
  "utf8",
);

console.log(`\n${site.toUpperCase()} HYBRID PREVIEW`);
console.log("Total blocks:", blocks.length);
console.log("Retrieval roles:", counts);

console.log("\nExample contextual blocks:");
console.log(
  blocks
    .filter((b) => b.retrievalRole === "context")
    .slice(0, 8)
    .map((b) => ({
      id: b.id,
      category: b.category,
      text: b.text.slice(0, 90),
    })),
);
