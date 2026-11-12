export const MAX_CHARS = 1400;

// Single source of truth for the classifier's category vocabulary.
// `run-ai-v2.ts` uses it for the structured-output schema.
export const BLOCK_CATEGORIES = [
  "company_claim",
  "customer_review",
  "manufacturer_claim",
  "pricing",
  "service_area",
  "contact",
  "fictional_demo",
  "form_ui",
  "navigation",
  "interface_noise",
  "other",
] as const;

export type BlockCategory = (typeof BLOCK_CATEGORIES)[number];

export type RetrievalRole = "primary" | "context" | "excluded";

export type Block = {
  id: number;
  category: BlockCategory;
  retrievalRole: RetrievalRole;
  relatedBlockIds: number[];
  text: string;
};

export type Chunk = {
  id: number;
  sourceUrl: string;
  retrievalRole: "primary" | "context";
  category: BlockCategory;
  // Source blocks, in document order. A block appears in exactly one chunk,
  // unless it was larger than MAX_CHARS: then every segment chunk lists it.
  blockIds: number[];
  // Original source text. Never cleaned.
  text: string;
  // Section label that applies to this chunk (see "Section labels" in
  // the README). The label block is metadata, not part of `text`.
  sectionTitle?: string;
  sectionBlockId?: number;
  // Present when one oversized block was split. Joining the segments in
  // order reproduces the block's text exactly.
  segment?: { index: number; count: number };
};

export type SearchableChunk = Chunk & {
  // Retrieval text: same-role blocks, decorative markup removed, section
  // title prepended. Empty when nothing searchable remains.
  searchText: string;
  // False when `searchText` is empty. The chunk is kept as evidence but
  // must not be embedded.
  embeddable: boolean;
};

// Markdown thematic breaks: `* * *`, `---`, `___`.
const THEMATIC_BREAK = /^(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const HEADING = /^#{1,6}\s/;
const HEADING_PREFIX = /^#{1,6}\s+/;
const H2 = /^##\s/;
// A heading that starts a major website section.
const MAJOR_HEADING = /^#{1,2}\s/;
// A Markdown heading that contains a price.
const PRICE_HEADING = /^#{1,6}\s+[$€£]\s*\d/m;
const GOOGLE_REVIEW_START = /^Posted on Google\b/i;
// Known Trustindex decorative image markup.
const TRUSTINDEX_IMAGE =
  /!\[[^\]\n]*\]\(https:\/\/cdn\.trustindex\.io\/assets\/platform\/Google\/[^)\s]+\)/g;

const SECTION_LABEL_MAX_CHARS = 60;
const SHORT_LABEL_MAX_CHARS = 80;

type Draft = {
  chunk: Chunk;
  // First block of the chunk; pricing relationships are judged against it.
  anchor: Block;
  // Text of the blocks that share the chunk's retrieval role.
  searchParts: string[];
};

type Section = {
  title: string;
  block: Block;
  used: boolean;
};

function isThematicBreak(block: Block) {
  return THEMATIC_BREAK.test(block.text.trim());
}

function isRelated(a: Block, b: Block) {
  return a.relatedBlockIds.includes(b.id) || b.relatedBlockIds.includes(a.id);
}

// `text` without the characters in [from, to) that fall inside `ranges`.
function withoutRanges(
  text: string,
  ranges: Array<[number, number]>,
  from: number,
  to: number,
) {
  let result = "";
  let position = from;

  for (const [start, end] of ranges) {
    if (end <= position || start >= to) continue;
    result += text.slice(position, Math.max(start, position));
    position = Math.min(end, to);
  }

  return result + text.slice(position, to);
}

function cleanSearchText(text: string) {
  return text
    .replace(TRUSTINDEX_IMAGE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Cut `text` into contiguous pieces of at most `max` characters, preferring
// paragraph, line, sentence, then word boundaries. Nothing is trimmed, so
// the pieces always concatenate back to the original text.
export function splitOversizedText(text: string, max = MAX_CHARS): string[] {
  const pieces: string[] = [];
  let rest = text;

  while (rest.length > max) {
    const window = rest.slice(0, max);
    const minimum = Math.floor(max / 2);

    const paragraph = window.lastIndexOf("\n\n") + 2;
    const line = window.lastIndexOf("\n") + 1;
    const sentence = [...window.matchAll(/[.!?]["')\]]?\s/g)]
      .map((match) => match.index + match[0].length)
      .at(-1);
    const word =
      Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t")) + 1;

    let cut =
      [paragraph, line, sentence ?? 0, word].find(
        (position) => position > minimum,
      ) ?? max;

    // Never split a surrogate pair.
    const last = rest.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;

    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }

  if (rest) pieces.push(rest);

  return pieces;
}

export function buildChunks(input: {
  sourceUrl: string;
  blocks: Block[];
}): SearchableChunk[] {
  const { blocks } = input;

  const seenIds = new Set<number>();
  for (const block of blocks) {
    if (seenIds.has(block.id)) {
      throw new Error(`Duplicate block id ${block.id} in ${input.sourceUrl}.`);
    }
    seenIds.add(block.id);
  }

  // Thematic breaks are boundaries whatever role the classifier gave them.
  const isBoundary = blocks.map(isThematicBreak);
  const isRetained = (index: number) =>
    isBoundary[index] === false && blocks[index]?.retrievalRole !== "excluded";

  // linkedBlocks: the retained blocks each block is linked to, in either
  // direction. Links to excluded blocks, separators, or unknown ids are
  // not evidence about how retained content groups together.
  const retainedIds = new Set(
    blocks.filter((_, index) => isRetained(index)).map((block) => block.id),
  );
  const linkedBlocks = new Map<number, Set<number>>();
  const link = (from: number, to: number) => {
    const linked = linkedBlocks.get(from) ?? new Set<number>();
    linked.add(to);
    linkedBlocks.set(from, linked);
  };
  for (const [index, block] of blocks.entries()) {
    if (!isRetained(index)) continue;
    for (const id of block.relatedBlockIds) {
      if (id === block.id || !retainedIds.has(id)) continue;
      link(block.id, id);
      link(id, block.id);
    }
  }

  // nextRetained[i]: the next retained block after i.
  const nextRetained: Array<Block | undefined> = new Array(blocks.length);
  let following: Block | undefined;
  for (let index = blocks.length - 1; index >= 0; index--) {
    nextRetained[index] = following;
    if (isRetained(index)) following = blocks[index];
  }

  // A heading, or a short label introducing one, starts a new website
  // section, so a menu section label no longer describes what follows.
  const opensWebsiteSection = blocks.map((block, index) => {
    if (MAJOR_HEADING.test(block.text)) return true;

    const next = nextRetained[index];

    return (
      block.text.length <= SHORT_LABEL_MAX_CHARS &&
      !block.text.includes("\n") &&
      !HEADING.test(block.text) &&
      next !== undefined &&
      H2.test(next.text)
    );
  });

  const drafts: Draft[] = [];
  let current: Draft | null = null;
  let section: Section | null = null;
  let pendingBoundary = false;

  const nextId = () => drafts.length;

  function flush() {
    if (current) {
      drafts.push(current);
      current = null;
    }
  }

  // A section label that no chunk carried would otherwise vanish, so it
  // becomes its own chunk. Callers flush the open chunk first.
  function closeSection() {
    if (section && !section.used) {
      drafts.push({
        chunk: {
          id: nextId(),
          sourceUrl: input.sourceUrl,
          retrievalRole: "primary",
          category: section.block.category,
          blockIds: [section.block.id],
          text: section.block.text,
        },
        anchor: section.block,
        searchParts: [section.block.text],
      });
    }

    section = null;
  }

  function openChunk(block: Block, text: string, index: number): Draft {
    // A section ends when content from another category starts a chunk, or
    // when a major heading starts a new website section.
    if (
      section &&
      (block.category !== section.block.category || opensWebsiteSection[index])
    ) {
      closeSection();
    }

    const sectionFields = section
      ? { sectionTitle: section.title, sectionBlockId: section.block.id }
      : {};

    if (section) section.used = true;

    return {
      chunk: {
        id: nextId(),
        sourceUrl: input.sourceUrl,
        retrievalRole: block.retrievalRole as "primary" | "context",
        category: block.category,
        blockIds: [block.id],
        text,
        ...sectionFields,
      },
      anchor: block,
      searchParts: [text],
    };
  }

  for (const [index, block] of blocks.entries()) {
    if (isBoundary[index]) {
      pendingBoundary = true;
      continue;
    }

    if (block.retrievalRole === "excluded") continue;

    const previousIsBoundary = isBoundary[index - 1] === true;
    const nextIsBoundary = isBoundary[index + 1] === true;

    // A short pricing label between two separators names the section
    // that follows. It is kept as metadata for the chunks in the section.
    const isSectionLabel =
      block.retrievalRole === "primary" &&
      block.category === "pricing" &&
      block.text.length <= SECTION_LABEL_MAX_CHARS &&
      !block.text.includes("\n") &&
      !/\d/.test(block.text) &&
      previousIsBoundary &&
      nextIsBoundary;

    if (isSectionLabel) {
      flush();
      closeSection();
      section = { title: block.text.trim(), block, used: false };
      pendingBoundary = false;
      continue;
    }

    // One block larger than the limit becomes several segment chunks.
    if (block.text.length > MAX_CHARS) {
      flush();

      const pieces = splitOversizedText(block.text);

      // A decorative image can straddle a cut, so it is located in the whole
      // block and removed from each segment's search text by position.
      const decorative = [...block.text.matchAll(TRUSTINDEX_IMAGE)].map(
        (match): [number, number] => [
          match.index,
          match.index + match[0].length,
        ],
      );
      let offset = 0;

      for (const [pieceIndex, piece] of pieces.entries()) {
        const draft = openChunk(block, piece, index);
        draft.chunk.segment = { index: pieceIndex, count: pieces.length };
        draft.searchParts = [
          withoutRanges(block.text, decorative, offset, offset + piece.length),
        ];
        offset += piece.length;
        drafts.push(draft);
      }

      pendingBoundary = false;
      continue;
    }

    const open: Draft | null = current;
    const chunk = open?.chunk ?? null;
    const nextBlock = nextRetained[index];

    // A new offering begins when a name precedes a new price,
    // and the current pricing chunk already contains a price.
    const startsNewPricingOffer =
      chunk !== null &&
      block.category === "pricing" &&
      nextBlock?.category === "pricing" &&
      PRICE_HEADING.test(nextBlock.text) &&
      (chunk.category !== "pricing" || PRICE_HEADING.test(chunk.text));

    // A block whose every retained link points inside the open chunk is a
    // dependent: an option or description attached to the item's price or to
    // another dependent. A block that is also linked to anything outside the
    // chunk may head an item of its own, so it is not treated as a dependent.
    const links = linkedBlocks.get(block.id);
    const isDependent =
      open !== null &&
      links !== undefined &&
      [...links].every((id) => open.chunk.blockIds.includes(id));

    // Pricing blocks belong to an item when they relate to its first block,
    // or are dependents of its blocks. A block linked to the item only
    // together with outside blocks does not join it, so one over-linked block
    // cannot chain two items together. Blocks the classifier left unlinked on
    // both sides carry no evidence either way and are not split here.
    const startsUnrelatedPricingItem =
      open !== null &&
      block.category === "pricing" &&
      open.chunk.category === "pricing" &&
      !isRelated(open.anchor, block) &&
      !isDependent &&
      (open.anchor.relatedBlockIds.length > 0 ||
        block.relatedBlockIds.length > 0);

    // Detect a repeated label from the current section.
    const repeatsCurrentHeading =
      chunk !== null &&
      chunk.text
        .split("\n")
        .some(
          (line) =>
            HEADING_PREFIX.test(line) &&
            line.replace(HEADING_PREFIX, "").trim().toLowerCase() ===
              block.text.trim().toLowerCase(),
        );

    const linkedToCurrent =
      chunk !== null &&
      block.relatedBlockIds.some((id) => chunk.blockIds.includes(id));

    // A short text label immediately before an H2 often
    // marks the beginning of a new website section.
    const startsLabeledSection =
      chunk !== null &&
      !repeatsCurrentHeading &&
      !linkedToCurrent &&
      block.text.length <= SHORT_LABEL_MAX_CHARS &&
      !block.text.includes("\n") &&
      !HEADING.test(block.text) &&
      nextBlock !== undefined &&
      H2.test(nextBlock.text);

    // Keep that label together with its following H2.
    const continuesSectionLabel =
      chunk !== null &&
      chunk.blockIds.length === 1 &&
      chunk.text.length <= SHORT_LABEL_MAX_CHARS &&
      !chunk.text.includes("\n") &&
      !HEADING.test(chunk.text) &&
      H2.test(block.text);

    const startsMajorSection = H2.test(block.text) && !continuesSectionLabel;

    const startsReview =
      block.category === "customer_review" &&
      GOOGLE_REVIEW_START.test(block.text);

    const startsHeading = HEADING.test(block.text);

    const keepLinkedWithPrimary =
      chunk !== null && chunk.retrievalRole === "primary" && linkedToCurrent;

    const roleChanged =
      chunk !== null &&
      chunk.retrievalRole !== block.retrievalRole &&
      !keepLinkedWithPrimary;

    const categoryChanged =
      chunk !== null &&
      chunk.category !== block.category &&
      !keepLinkedWithPrimary;

    const wouldExceedLimit =
      chunk !== null && chunk.text.length + block.text.length + 2 > MAX_CHARS;

    if (
      chunk &&
      (pendingBoundary ||
        startsNewPricingOffer ||
        startsUnrelatedPricingItem ||
        startsLabeledSection ||
        startsMajorSection ||
        startsReview ||
        roleChanged ||
        categoryChanged ||
        wouldExceedLimit ||
        (startsHeading && !linkedToCurrent && !continuesSectionLabel))
    ) {
      flush();
    }

    pendingBoundary = false;

    if (!current) {
      current = openChunk(block, block.text, index);
    } else {
      const draft: Draft = current;
      draft.chunk.blockIds.push(block.id);
      draft.chunk.text += "\n\n" + block.text;

      if (block.retrievalRole === draft.chunk.retrievalRole) {
        draft.searchParts.push(block.text);
      }
    }
  }

  flush();
  closeSection();

  return drafts.map(({ chunk, searchParts }) => {
    const content = cleanSearchText(searchParts.join("\n\n"));
    const searchText =
      content && chunk.sectionTitle
        ? `${chunk.sectionTitle}\n\n${content}`
        : content;

    return { ...chunk, searchText, embeddable: searchText.length > 0 };
  });
}
