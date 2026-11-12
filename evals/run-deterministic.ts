import { mkdir, readFile, writeFile } from "node:fs/promises";

import { parseEvalArgs } from "./eval-common.js";

const { site } = parseEvalArgs(process.argv.slice(2));

const filename = `${site}-page`;

type PageFixture = {
  url: string;
  markdown: string;
};

const page = JSON.parse(
  await readFile(`evals/fixtures/${filename}.json`, "utf8"),
) as PageFixture;

// 1. Divide Markdown into blocks at blank lines.
const rawBlocks = page.markdown
  .split(/\n\s*\n/)
  .map((text) => text.trim())
  .filter(Boolean);

// 2. Classify each block using simple rules.
const blocks = rawBlocks.map((text, id) => {
  const type = /^#{1,6}\s/.test(text)
    ? "heading"
    : /^-\s/m.test(text)
      ? "list"
      : "text";

  // Flag standalone UI step numbers, e.g. "2. 01".
  const isNoise = /^\d+\.\s+\d{2}$/.test(text);

  return {
    id,
    type,
    action: isNoise ? "drop" : "keep",
    text,
  };
});

// 3. Save the result without modifying the original fixture.
await mkdir("evals/results", { recursive: true });

await writeFile(
  `evals/results/${filename}.deterministic.json`,
  JSON.stringify({ sourceUrl: page.url, blocks }, null, 2),
  "utf8",
);

// 4. Display a summary.
console.log("Total blocks:", blocks.length);
console.log(
  "Flagged as noise:",
  blocks.filter((block) => block.action === "drop").length,
);
console.log("\nFirst 10 blocks:");
console.log(JSON.stringify(blocks.slice(0, 10), null, 2));
