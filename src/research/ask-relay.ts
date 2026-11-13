import type { Pool } from "pg";
import {
  countEmbeddedResearchChunks,
  searchResearchChunks,
} from "../data/research-embeddings.js";
import type { AnswerSource, Answerer } from "./openai-answerer.js";
import { isResearchEmbedding, type Embedder } from "./openai-embeddings.js";

export const ASK_RELAY_RESULT_LIMIT = 6;

export const NO_INDEXED_RESEARCH_ANSWER =
  "Relay has no embedded research for this prospect, so it cannot answer from evidence.";
export const UNVERIFIED_ANSWER =
  "Relay withheld the drafted answer because its citations could not be verified against the retrieved research.";

export type AskRelayResult = {
  question: string;
  status: "answered" | "insufficient_evidence";
  reason:
    | null
    | "no_indexed_research"
    | "model_reported"
    | "unverified_citations";
  answer: string;
  // Present only for verified answers. URLs come from stored chunks, never
  // from the model.
  citations: { sourceId: string; sourceUrl: string; quote: string }[];
  retrieved: { sourceId: string; sourceUrl: string; similarity: number }[];
};

type DraftAnswer = {
  status: "answered" | "insufficient_evidence";
  answer: string;
  citations: { source: string; quote: string }[];
};

export type CitationFailure = {
  citationIndex: number;
  sourceId: string | null;
  reason: "no_citations" | "quote_too_short" | "quote_not_in_source";
  quote: string;
  sourceContext: string;
};

function exact(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function text(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    Buffer.byteLength(value) <= limit &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  );
}

export function parseDraftAnswer(
  raw: unknown,
  sourceIds: readonly string[],
): DraftAnswer {
  let value: unknown;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("Answer response is not valid JSON.");
  }
  if (
    !exact(value, ["status", "answer", "citations"]) ||
    !["answered", "insufficient_evidence"].includes(String(value.status)) ||
    !text(value.answer, 4000) ||
    !Array.isArray(value.citations) ||
    value.citations.length > 12 ||
    !value.citations.every(
      (citation) =>
        exact(citation, ["source", "quote"]) &&
        sourceIds.includes(String(citation.source)) &&
        text(citation.quote, 1000),
    )
  )
    throw new Error("Answer response does not match the expected schema.");
  return value as DraftAnswer;
}

// Tolerates whitespace, typographic quotes, Markdown emphasis, and case, but
// nothing that changes the words.
function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Only remove destinations from complete inline website links in the source.
// The quote is never rewritten, so an invented URL cannot be accepted.
const INLINE_WEBSITE_LINK = /\[([^\[\]\r\n]+)\]\(https?:\/\/[^\s()]+\)/gi;

function quoteInSource(quote: string, sourceText: string): boolean {
  const raw = normalized(sourceText);
  if (raw.includes(quote)) return true;
  const labelsWithBrackets = sourceText.replace(
    INLINE_WEBSITE_LINK,
    (_link, label: string) => `[${label}]`,
  );
  return (
    normalized(labelsWithBrackets).includes(quote) ||
    normalized(sourceText.replace(INLINE_WEBSITE_LINK, "$1")).includes(quote)
  );
}

// An answer is verified only when it cites at least one excerpt and every
// quote appears in the cited excerpt's raw text or rendered website link labels.
export function citationsVerified(
  draft: DraftAnswer,
  sources: readonly AnswerSource[],
  onFailure?: (failure: CitationFailure) => void,
): boolean {
  const report = (failure: CitationFailure) => {
    try {
      onFailure?.(failure);
    } catch {
      // Diagnostics cannot change the result.
    }
  };
  if (!draft.citations.length) {
    report({
      citationIndex: -1,
      sourceId: null,
      reason: "no_citations",
      quote: "",
      sourceContext: "",
    });
    return false;
  }
  let verified = true;
  draft.citations.forEach((citation, citationIndex) => {
    const source = sources.find((item) => item.id === citation.source);
    const quote = normalized(citation.quote);
    if (source && quote.length >= 4 && quoteInSource(quote, source.text)) return;
    verified = false;
    const sourceText = source ? normalized(source.text) : "";
    const anchor = quote
      .split(/\W+/)
      .find((word) => word.length >= 4 && sourceText.includes(word));
    const position = anchor ? sourceText.indexOf(anchor) : -1;
    report({
      citationIndex,
      sourceId: citation.source,
      reason: quote.length < 4 ? "quote_too_short" : "quote_not_in_source",
      quote: citation.quote,
      sourceContext:
        position < 0
          ? ""
          : sourceText.slice(Math.max(0, position - 80), position + 160),
    });
  });
  return verified;
}

export async function askRelay(
  input: { prospectId: string; question: string },
  deps: {
    database: Pick<Pool, "query">;
    embed: Embedder;
    answer: Answerer;
    limit?: number;
    onCitationFailure?: ((failure: CitationFailure) => void) | undefined;
  },
): Promise<AskRelayResult> {
  const question = input.question?.trim();
  if (!text(question, 2000))
    throw new Error("Question must be nonempty text of at most 2000 bytes.");
  const insufficient = (
    reason: Exclude<AskRelayResult["reason"], null>,
    answer: string,
    retrieved: AskRelayResult["retrieved"],
  ): AskRelayResult => ({
    question,
    status: "insufficient_evidence",
    reason,
    answer,
    citations: [],
    retrieved,
  });

  // No provider call when the prospect has nothing to search.
  if (!(await countEmbeddedResearchChunks(input.prospectId, deps.database)))
    return insufficient("no_indexed_research", NO_INDEXED_RESEARCH_ANSWER, []);

  const [embedding] = await deps.embed([question]);
  if (!isResearchEmbedding(embedding))
    throw new Error("Embedding provider returned an invalid response.");
  const chunks = await searchResearchChunks(
    {
      prospectId: input.prospectId,
      embedding,
      limit: deps.limit ?? ASK_RELAY_RESULT_LIMIT,
    },
    deps.database,
  );
  if (!chunks.length)
    return insufficient("no_indexed_research", NO_INDEXED_RESEARCH_ANSWER, []);

  const sources: AnswerSource[] = chunks.map((chunk, position) => ({
    id: `S${position + 1}`,
    sourceUrl: chunk.sourceUrl,
    text: chunk.content,
  }));
  const retrieved = chunks.map((chunk, position) => ({
    sourceId: sources[position]!.id,
    sourceUrl: chunk.sourceUrl,
    similarity: chunk.similarity,
  }));

  const draft = parseDraftAnswer(
    await deps.answer(question, sources),
    sources.map((source) => source.id),
  );
  if (draft.status === "insufficient_evidence")
    return insufficient("model_reported", draft.answer, retrieved);
  if (!citationsVerified(draft, sources, deps.onCitationFailure))
    return insufficient("unverified_citations", UNVERIFIED_ANSWER, retrieved);

  return {
    question,
    status: "answered",
    reason: null,
    answer: draft.answer,
    citations: draft.citations.map((citation) => ({
      sourceId: citation.source,
      sourceUrl: sources.find((source) => source.id === citation.source)!
        .sourceUrl,
      quote: citation.quote,
    })),
    retrieved,
  };
}
