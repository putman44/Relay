import { readFile, writeFile } from "node:fs/promises";
import { buildChunks, MAX_CHARS, type Block } from "./chunk-engine.js";
import { parseEvalArgs } from "./eval-common.js";

const { site } = parseEvalArgs(process.argv.slice(2));

const filename = `${site}-page`;

const input = JSON.parse(
  await readFile(`evals/results/${filename}.hybrid.json`, "utf8"),
) as {
  sourceUrl: string;
  blocks: Block[];
};

// All chunking decisions now happen in the reusable engine.
const searchableChunks = buildChunks(input);

await writeFile(
  `evals/results/${filename}.chunks.json`,
  JSON.stringify(
    {
      sourceUrl: input.sourceUrl,
      chunks: searchableChunks,
    },
    null,
    2,
  ),
  "utf8",
);

console.log(`\n${site.toUpperCase()} CHUNK PREVIEW`);
console.log("Generated chunks:", searchableChunks.length);

console.log("\nFirst 10 chunks:");
for (const chunk of searchableChunks.slice(0, 10)) {
  console.log({
    id: chunk.id,
    role: chunk.retrievalRole,
    category: chunk.category,
    blockIds: chunk.blockIds,
    characters: chunk.text.length,
    preview: chunk.text.slice(0, 120),
  });
}

console.log(
  "\nOversized chunks:",
  searchableChunks.filter((chunk) => chunk.text.length > MAX_CHARS).length,
);
console.log(
  "Segments of oversized blocks:",
  searchableChunks.filter((chunk) => chunk.segment).length,
);
console.log(
  "Kept as evidence but not embeddable:",
  searchableChunks.filter((chunk) => !chunk.embeddable).length,
);
