// Deterministic, source-preserving chunking of saved research Markdown.
//
// Every chunk is an exact slice of the document: content === markdown.slice(
// start, end). The same Markdown always yields the same chunks, so stored
// chunks can be compared with a fresh chunking to detect conflicts.

export const RESEARCH_CHUNK_MAX_CHARS = 1200;

export type ResearchTextChunk = {
  index: number;
  start: number;
  end: number;
  content: string;
};

// Paragraph blocks are separated by one or more blank lines.
const BLANK_LINES = /\r?\n[ \t]*(?:\r?\n[ \t]*)+/g;
const HEADING = /^#{1,6}\s/;
// Markdown thematic breaks: `* * *`, `---`, `___`.
const THEMATIC_BREAK = /^(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;

type Span = { start: number; end: number };

// [start, end) without leading or trailing whitespace; null when empty.
function trimmed(markdown: string, start: number, end: number): Span | null {
  while (start < end && /\s/.test(markdown[start]!)) start++;
  while (end > start && /\s/.test(markdown[end - 1]!)) end--;
  return start < end ? { start, end } : null;
}

// Text a reader would see: image markup, link destinations, and bare URLs
// carry no searchable words.
function hasText(text: string): boolean {
  const visible = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, " ");
  return /[\p{L}\p{N}]/u.test(visible);
}

// Cut one oversized block at line, sentence, then word boundaries, falling
// back to a hard cut. Pieces are exact, trimmed slices in document order.
function splitOversized(markdown: string, block: Span, max: number): Span[] {
  const pieces: Span[] = [];
  let position = block.start;

  while (block.end - position > max) {
    const window = markdown.slice(position, position + max);
    const minimum = Math.floor(max / 2);
    const line = window.lastIndexOf("\n") + 1;
    const sentence =
      [...window.matchAll(/[.!?]["')\]]?\s/g)]
        .map((match) => match.index + match[0].length)
        .at(-1) ?? 0;
    const word = window.lastIndexOf(" ") + 1;
    let cut =
      [line, sentence, word].find((offset) => offset > minimum) ?? max;

    // Never split a surrogate pair.
    const last = markdown.charCodeAt(position + cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;

    const piece = trimmed(markdown, position, position + cut);
    if (piece) pieces.push(piece);
    position += cut;
  }

  const rest = trimmed(markdown, position, block.end);
  if (rest) pieces.push(rest);
  return pieces;
}

export function chunkResearchMarkdown(
  markdown: string,
  max = RESEARCH_CHUNK_MAX_CHARS,
): ResearchTextChunk[] {
  if (typeof markdown !== "string")
    throw new Error("Research Markdown must be a string.");
  if (!Number.isSafeInteger(max) || max < 100)
    throw new Error("Chunk size must be an integer of at least 100.");

  const blocks: Span[] = [];
  let blockStart = 0;
  for (const match of markdown.matchAll(BLANK_LINES)) {
    const block = trimmed(markdown, blockStart, match.index);
    if (block) blocks.push(block);
    blockStart = match.index + match[0].length;
  }
  const lastBlock = trimmed(markdown, blockStart, markdown.length);
  if (lastBlock) blocks.push(lastBlock);

  const spans: Span[] = [];
  // headingOnly: the open chunk holds nothing but headings so far, so the
  // next heading joins it instead of leaving a heading-only chunk behind.
  let current: (Span & { headingOnly: boolean }) | null = null;
  const flush = () => {
    if (current) spans.push({ start: current.start, end: current.end });
    current = null;
  };

  for (const block of blocks) {
    const text = markdown.slice(block.start, block.end);

    if (THEMATIC_BREAK.test(text)) {
      flush();
      continue;
    }
    if (!hasText(text)) continue;

    if (block.end - block.start > max) {
      flush();
      spans.push(...splitOversized(markdown, block, max));
      continue;
    }

    const heading = HEADING.test(text);
    if (
      current &&
      ((heading && !current.headingOnly) || block.end - current.start > max)
    ) {
      flush();
    }

    if (!current) {
      current = { start: block.start, end: block.end, headingOnly: heading };
    } else {
      current.end = block.end;
      current.headingOnly &&= heading;
    }
  }
  flush();

  return spans.map((span, index) => ({
    index,
    start: span.start,
    end: span.end,
    content: markdown.slice(span.start, span.end),
  }));
}
