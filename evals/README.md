# Relay Research Evaluation Framework

Experimental pipeline for processing website research into
retrieval-ready chunks.

## Architecture

```text
Firecrawl Markdown
  -> Deterministic block extraction   (run-deterministic.ts)
  -> AI-assisted classification       (run-ai-v2.ts)
  -> Hybrid retrieval roles           (preview-hybrid.ts)
  -> Relationship-aware chunking      (chunk-engine.ts, via preview-chunks.ts)
```

- `chunk-engine.ts`: the reusable, pure chunking implementation. It does no
  I/O, so it can move into production code unchanged.
- `eval-common.ts`: site and flag parsing, the OpenAI opt-in guard, and
  validation of AI decisions, shared by the scripts.
- `run-*.ts` and `preview-*.ts`: evaluation scripts that read and write the
  local `fixtures/` and `results/` directories.

This is an experimental evaluation framework, not yet
connected to Relay's production ingestion pipeline.

## Public regression tests

The public tests live in `tests/research/` and use fictional examples only.
`npm test` discovers them through its `tests/**/*.test.ts` pattern, so
`npm run verify` (and therefore CI) runs them. They need no API credentials,
captured website data, or database access. Run them directly with:

```bash
node --import tsx --test \
  tests/research/chunk-engine.test.ts \
  tests/research/eval-openai-guard.test.ts
```

- `chunk-engine.test.ts`: pricing offers, menu options and descriptions,
  over-linked blocks, section labels and their scope, thematic breaks,
  decorative-image cleanup (including images cut by segmentation), customer
  reviews, oversized blocks, empty search text, and block provenance.
- `eval-openai-guard.test.ts`: the OpenAI opt-in guard and validation of AI
  decisions.

## Chunking behavior

`buildChunks({ sourceUrl, blocks })` takes classified blocks in document
order and returns `SearchableChunk[]`. `chunk.text` is always the original
source text. `chunk.searchText` is the text to embed.

- **Boundaries.** A Markdown thematic break (`* * *`, `---`, `___`) always
  ends the current chunk, whatever role the classifier gave it. Breaks are
  never chunk content.
- **Pricing items.** A pricing block joins the open pricing chunk when it is
  related, in either direction, to that chunk's first block, or when it is a
  _dependent_: every retained block it is linked to, in either direction, is
  already in the chunk. This keeps an option or description that the
  classifier linked only to its item's price (`Soup`, `$4`, `Add bread $1`).
  A block that is also linked to anything outside the chunk may head an item
  of its own, so it starts a new chunk. One over-linked block therefore cannot
  chain two products together. Links to excluded blocks, separators, and
  unknown ids are ignored. Blocks the classifier left unrelated on both sides
  carry no evidence and are not split.
- **Section labels.** A short, digit-free pricing label between two
  separators (for example a menu section name) becomes `sectionTitle` and
  `sectionBlockId` on the chunks that follow it. It is not a standalone chunk
  and is prepended to `searchText`. The section ends when a chunk from
  another category starts, when a chunk starts with a `#` or `##` heading (or
  a short label that introduces an `##` heading), or at the next label. A
  label with no content after it is kept as its own chunk.
- **Decorative images.** Known Trustindex images are removed from
  `searchText` only. Blocks whose role differs from the chunk's role (for
  example context images inside a primary chunk) are also excluded from
  `searchText`. `text` is never changed. In a segmented oversized block, an
  image that straddles a cut is located in the whole block and removed from
  both segments' `searchText`, so no markup fragment survives.
- **Oversized blocks.** A single block longer than `MAX_CHARS` is split at
  paragraph, line, sentence, or word boundaries into segment chunks. Each lists
  the block in `blockIds` and carries `segment: { index, count }`. Joining the
  segments reproduces the block exactly.
- **Empty search text.** A chunk with nothing searchable is kept as evidence
  with `embeddable: false`. Consumers must skip it when embedding.

Provenance: every retained, non-separator block appears in exactly one
chunk's `blockIds`, or is a section label referenced by `sectionBlockId`.
Segments of an oversized block are the one case where a block id repeats.
Duplicate block ids in the input throw.

## Local evaluations

The following directories are excluded from Git:

- `fixtures/`: Local website captures and expectations (`{ url, markdown }`)
- `results/`: Generated evaluation data and AI decisions
- `local/`: Private real-world regression tests

Run scripts from the repository root, because paths are relative to it. The
sites are `relay`, `hvac`, `restaurant`, and `counseling`.

| Step | Command                                               | Network       |
| ---- | ----------------------------------------------------- | ------------- |
| 1    | `node --import tsx evals/run-deterministic.ts`        | none          |
| 2    | `node --import tsx evals/run-ai-v2.ts --allow-openai` | OpenAI (paid) |
| 3    | `node --import tsx evals/preview-hybrid.ts`           | none          |
| 4    | `node --import tsx evals/preview-chunks.ts`           | none          |

Each takes an optional site argument, for example
`evals/preview-chunks.ts restaurant`. Steps 3 and 4 can be re-run from saved
AI decisions without any API calls.

### Live OpenAI runners

`run-ai.ts` (v1, `relay` and `hvac` only) and `run-ai-v2.ts` send captured
website content to OpenAI and incur usage costs. They refuse to run unless you
pass `--allow-openai`, and credentials in `.env` or the environment are never
treated as permission. Pass the flag only for a run you have decided to make.
Requests use `store: false`. Coding agents must not pass the flag without
explicit authorization for that run (see `AGENTS.md`).

`--highlight=<regex>` prints the AI decisions for blocks matching a pattern.

## Known limitations and deferred work

- Block-role policy lives in `preview-hybrid.ts`, outside the engine, and is
  untested. Move it into a pure, tested function before production use.
- The category-to-role mapping, `Posted on Google`, the Trustindex image
  pattern, and `###` price headings are tuned to the four evaluation sites.
  Production sources will need a configurable rule set.
- Section labels are recognized only for the `pricing` category, without
  digits.
- A related block that appears after another item's blocks cannot rejoin its
  item, because chunks follow document order.
- Pricing dependents must link only to blocks in the open chunk. Three cases
  are held apart instead of guessed at; each keeps every block and never
  merges two items, but can leave an option separated from its item:
  - an option linked only to another option (`Soup`, `$4`, `Add bread`,
    `Add butter`): this has the same shape as an over-linked next item;
  - an option linked to two items' prices;
  - an option that the classifier left unlinked on both sides, after an item
    that has links.
- Section labels are only ended by a category change, a `#`/`##` heading, a
  label before an `##` heading, or the next label. Unlabeled priced items that
  follow the labeled section after only a separator still inherit its title
  (`sectionTitle` can be wrong for them), because they cannot be told apart
  from more items of that section.
- Oversized-block splitting is text-based, not Markdown-aware, and can cut
  inside a link when no whitespace is available.
- `searchText` can exceed `MAX_CHARS` by the length of the section title.
- The OpenAI request code is duplicated between `run-ai.ts` and
  `run-ai-v2.ts`. Share it, or retire v1, once live calls can be tested.
- Relationship data from the classifier is not checked for symmetry.
- Storing `embeddable`, `segment`, and `sectionBlockId` needs schema
  decisions during production integration.

## Historical chunk counts

Earlier snapshots of the local evaluations show different counts. They are not
regressions:

| Site  | Before extraction | Current |
| ----- | ----------------- | ------- |
| relay | 25                | 24      |
| hvac  | 39                | 38      |

The earlier script split a trailing context block (a demo label or a "Read
more" link) off the primary chunk it was linked to, because its role and
category differed. The engine keeps such a block with a primary chunk it links
to. Restaurant (36) and counseling (24) were first recorded with the engine.
Chunk counts are not a quality measure: compare `blockIds` coverage and the
private regression tests instead.

## Status

- Reusable chunking engine implemented
- Public synthetic regression tests run in `npm run verify`
- Four local industry evaluations
- Vector retrieval not yet implemented
- Production integration not yet implemented
