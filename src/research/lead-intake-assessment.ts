import type { Pool } from "pg";
import {
  completeAssessment,
  currentEvidenceVersion,
  endAssessmentWithoutResult,
  reserveAssessment,
} from "../data/lead-assessments.js";
import {
  searchResearchChunks,
  searchResearchChunksByKeyword,
} from "../data/research-embeddings.js";
import { citationsVerified, exact, text } from "./ask-relay.js";
import type { AnswerSource } from "./openai-answerer.js";
import {
  ASSESSMENT_CATEGORY_IDS,
  type AssessmentCategoryId,
  type Assessor,
} from "./openai-assessor.js";
import {
  classifyFit,
  discoveryQuestionProblem,
  FIT_BASIS_TEXT,
  FIT_RUBRIC_VERSION,
  FIT_SIGNAL_IDS,
  signalKind,
  signalLabel,
  signalStatement,
  signalSupport,
  type FitBasis,
  type FitGrade,
  type FitSignalId,
} from "./fit-rubric.js";
import {
  composeHypothesis,
  enclosingText,
  findPhoneNumber,
  isInstructionLike,
  isSuspiciousText,
  observationStatement,
  observationSupport,
  observationType,
  OBSERVATION_TYPE_IDS,
  phoneNumberContradicted,
  resolveTelLinks,
  unknownTopic,
  unknownText,
  UNKNOWN_IDS,
  type UnknownId,
} from "./intake-evidence.js";
import { isResearchEmbedding, type Embedder } from "./openai-embeddings.js";

// Retrieval bounds. Vector results fill each category up to perCategory; keyword
// results reserve up to keywordPerCategory of those slots, so the evidence budget
// per category (and in total) is unchanged: keyword matches replace weaker vector
// matches instead of adding to them.
export const ASSESSMENT_RETRIEVAL_LIMITS = {
  perCategory: 5,
  keywordPerCategory: 2,
  // Keyword matches are taken best-first, but no more than this many from one page,
  // so the evidence comes from distinct relevant pages.
  maxKeywordPerPage: 2,
  maxChunks: 30,
  maxBytes: 36_000,
} as const;
export type AssessmentRetrievalLimits = {
  -readonly [K in keyof typeof ASSESSMENT_RETRIEVAL_LIMITS]: number;
};
// Candidates read per slot. Reading is cheap and bounded; only the merge decides what
// reaches the model. Keyword reads leave room for the per-page cap, and vector reads
// leave room to drop exact duplicates (a site-wide widget repeated on every page used
// 8 of 22 slots in the first live run) without leaving a category short.
const KEYWORD_CANDIDATES_PER_SLOT = 3;
const VECTOR_CANDIDATE_FACTOR = 2;

// Each query is embedded once per assessment and searched within one prospect.
// keywords is PostgreSQL websearch syntax over the same prospect's stored chunks.
// keywordSlots overrides keywordPerCategory where the exact words carry the signal.
export const ASSESSMENT_CATEGORIES: readonly {
  id: AssessmentCategoryId;
  label: string;
  query: string;
  keywords: string;
  keywordSlots?: number;
}[] = [
  {
    id: "phone_intake",
    label: "Phone intake and contact availability",
    query:
      "Phone number to call the business, office hours, who answers calls, and ways to reach the company",
    keywords: 'call or phone or telephone or "office hours" or "business hours"',
  },
  {
    id: "website_forms",
    label: "Website forms and service requests",
    query:
      "Contact form or request form on the website to ask for service, a quote, or an estimate",
    keywords: 'form or quote or estimate or "request service" or "service request"',
  },
  {
    id: "online_booking",
    label: "Online scheduling and booking",
    query:
      "Book or schedule an appointment online, an online booking calendar, or scheduling a visit",
    keywords: '"book online" or "online booking" or "schedule online" or "schedule an appointment" or booking',
  },
  {
    id: "after_hours",
    label: "After-hours and emergency intake",
    query:
      "24/7 emergency service, after-hours or weekend availability, on-call or urgent requests",
    // No "after hours" or "on call": PostgreSQL drops stop words, so those collapse to the
    // very common words "hour" and "call" and would outrank the emergency pages.
    // ("evening" stems to "even", which matches "even if", so it is not used either.)
    keywords: 'emergency or "24/7" or weekend or "around the clock"',
    keywordSlots: 3,
  },
  {
    id: "follow_up",
    label: "Lead acknowledgment and follow-up",
    query:
      "How and how quickly the business responds to a request, confirmations, callbacks, and follow-up with customers",
    keywords: '"call you back" or callback or "get back to you" or "follow up"',
  },
  {
    id: "crm_integrations",
    label: "CRM, field-service software, and integrations",
    query:
      "Customer portal, CRM, field-service or scheduling software, payment and invoicing tools, and integrations",
    keywords: 'portal or crm or software or "pay online" or "online payment"',
  },
];

export type EvidenceCandidate = {
  id: string;
  sourceUrl: string;
  content: string;
};
export type EvidenceVia = "vector" | "keyword" | "both";

const evidenceKey = (content: string) =>
  content.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

// Pure: combines each category's vector and keyword candidates under the bounds.
// Keyword matches go first, best-ranked first with a per-page cap; the vector
// matches fill the rest. Categories are served in rounds, one pick each per round,
// so a tight chunk or byte budget is shared fairly instead of the first categories
// taking all of it. A chunk another category already chose still counts toward this
// category (but never twice), and a chunk whose text duplicates or sits inside an
// earlier choice (or is a near-copy of one) is dropped. The chunk and byte budgets
// are hard limits. via records which searches found each chunk for the categories
// that picked it.
export function mergeAssessmentEvidence<T extends EvidenceCandidate>(
  perCategory: readonly { vector: readonly T[]; keyword: readonly T[]; keywordSlots?: number }[],
  limits: AssessmentRetrievalLimits = ASSESSMENT_RETRIEVAL_LIMITS,
): { candidate: T; via: EvidenceVia }[] {
  const chosen: T[] = [];
  const keys: string[] = [];
  const ids = new Set<string>();
  const route = new Map<string, { vector: boolean; keyword: boolean }>();
  let bytes = 0;
  const states = perCategory.map((entry) => ({
    picked: 0,
    keywordIndex: 0,
    keywordTaken: 0,
    vectorIndex: 0,
    own: new Set<string>(),
    perPage: new Map<string, number>(),
    vectorIds: new Set(entry.vector.map((item) => item.id)),
    keywordIds: new Set(entry.keyword.map((item) => item.id)),
  }));
  type State = (typeof states)[number];

  const take = (item: T, state: State): boolean => {
    if (state.own.has(item.id)) return false;
    if (!ids.has(item.id)) {
      const key = evidenceKey(item.content);
      // Redundant: the same text, text inside an earlier choice, or a near-copy that only adds a
      // little to one. A larger chunk that merely contains a short earlier one (a page title, say)
      // carries new information and is kept.
      if (!key || keys.some((prior) => prior.includes(key) || (key.includes(prior) && prior.length >= key.length * 0.8)))
        return false;
      const size = Buffer.byteLength(item.content);
      if (chosen.length >= limits.maxChunks || bytes + size > limits.maxBytes) return false;
      chosen.push(item);
      keys.push(key);
      ids.add(item.id);
      bytes += size;
    }
    state.own.add(item.id);
    state.picked++;
    const flags = route.get(item.id) ?? { vector: false, keyword: false };
    if (state.vectorIds.has(item.id)) flags.vector = true;
    if (state.keywordIds.has(item.id)) flags.keyword = true;
    route.set(item.id, flags);
    return true;
  };

  for (let progress = true; progress; ) {
    progress = false;
    for (const [index, entry] of perCategory.entries()) {
      const state = states[index]!;
      if (state.picked >= limits.perCategory) continue;
      const slots = entry.keywordSlots ?? limits.keywordPerCategory;
      let took = false;
      while (!took && state.keywordTaken < slots && state.keywordIndex < entry.keyword.length) {
        const item = entry.keyword[state.keywordIndex++]!;
        if ((state.perPage.get(item.sourceUrl) ?? 0) >= limits.maxKeywordPerPage) continue;
        if (take(item, state)) {
          took = true;
          state.keywordTaken++;
          state.perPage.set(item.sourceUrl, (state.perPage.get(item.sourceUrl) ?? 0) + 1);
        }
      }
      while (!took && state.vectorIndex < entry.vector.length) took = take(entry.vector[state.vectorIndex++]!, state);
      if (took) progress = true;
    }
  }
  return chosen.map((candidate) => {
    const flags = route.get(candidate.id)!;
    return { candidate, via: flags.vector && flags.keyword ? "both" : flags.keyword ? "keyword" : "vector" };
  });
}

export class AssessmentOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssessmentOutputError";
  }
}

export type VerifiedCitation = {
  sourceId: string;
  sourceUrl: string;
  chunkId: string;
  quote: string;
};
// Wording is written by the server from an approved type, never by the model.
export type VerifiedStatement = {
  statement: string;
  citations: VerifiedCitation[];
};
export type Unknown = { id: UnknownId; text: string };
// Quoted evidence that relates to a claim but does not plainly show it. It is
// not counted, never graded, and shown as Unconfirmed.
export type Unconfirmed = {
  scope: "observation" | "signal";
  id: string;
  label: string;
  citations: VerifiedCitation[];
};
export type Hypothesis = {
  category: AssessmentCategoryId;
  // Model prose, always shown as a hypothesis and never counted as evidence.
  statement: string;
  // Resolved by the server from evidence the server accepted.
  observed: VerifiedStatement & { ref: string };
  unknown: Unknown;
};

export type AssessmentResult = {
  schemaVersion: 3;
  // Composed by the server from accepted observations. Null when there are none.
  summary: VerifiedStatement | null;
  categories: {
    category: AssessmentCategoryId;
    label: string;
    observations: (VerifiedStatement & { type: string; label: string })[];
    unknowns: Unknown[];
    // Possible Relay opportunities to test; never findings.
    hypotheses: string[];
    discoveryQuestions: string[];
  }[];
  unconfirmed: Unconfirmed[];
  // Null when the model's version failed the hypothesis standard or cited
  // evidence the server did not accept.
  primaryOpportunityHypothesis: Hypothesis | null;
  // Null when the model's question failed the discovery question standard.
  primaryDiscoveryQuestion: string | null;
  fit: {
    // Derived by the server from validated signals under fit-rubric.ts.
    grade: FitGrade;
    basis: FitBasis;
    rubricVersion: string;
    rationale: string;
    signals: (VerifiedStatement & {
      id: FitSignalId;
      label: string;
      kind: "complexity" | "limited_relevance";
    })[];
    // Economic and operational signals that remain unclear.
    unknowns: Unknown[];
  };
  // At most three; fewer when some did not meet the standards.
  topOpportunities: (Hypothesis & { title: string })[];
  // flagged: the excerpt contained instruction-like text, treated as evidence only.
  // via: whether vector search, keyword search, or both found the excerpt.
  sources: { sourceId: string; sourceUrl: string; flagged: boolean; via: EvidenceVia }[];
  withheld: number;
};

export type RetrievedSource = AnswerSource & { chunkId: string; via: EvidenceVia };

type Cite = { source: string; quote: string };
// A hypothesis is two ids. The server composes the sentence, so the model supplies
// no prose for it and it can only rest on evidence the server accepted.
type DraftHypothesis = { observed: string; unknown: UnknownId };
type Draft = {
  categories: {
    category: AssessmentCategoryId;
    observations: { type: string; citations: Cite[] }[];
    unknowns: UnknownId[];
    hypotheses: DraftHypothesis[];
    discoveryQuestions: string[];
  }[];
  primary: DraftHypothesis & { category: AssessmentCategoryId };
  primaryQuestion: string;
  fit: { signals: { signal: FitSignalId; citations: Cite[] }[]; unknowns: UnknownId[] };
  top: (DraftHypothesis & { category: AssessmentCategoryId })[];
};

const reject = (): never => {
  throw new AssessmentOutputError(
    "Assessment response does not match the expected schema.",
  );
};
const TEXT_LIMIT = 1500;
const line = (value: unknown): string => (text(value, TEXT_LIMIT) ? value : reject());
const list = <T>(value: unknown, max: number, item: (entry: unknown) => T): T[] =>
  Array.isArray(value) && value.length <= max ? value.map(item) : reject();
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T =>
  allowed.includes(value as T) ? (value as T) : reject();
const EVIDENCE_REFS: readonly string[] = [...OBSERVATION_TYPE_IDS, ...FIT_SIGNAL_IDS];

export function parseAssessmentDraft(
  raw: unknown,
  sourceIds: readonly string[],
): Draft {
  let value: unknown;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new AssessmentOutputError("Assessment response is not valid JSON.");
  }
  const cites = (entry: unknown): Cite[] =>
    list(entry, 4, (citation) =>
      exact(citation, ["source", "quote"]) &&
      sourceIds.includes(String(citation.source)) &&
      text(citation.quote, 1000)
        ? { source: String(citation.source), quote: citation.quote }
        : reject(),
    );
  const unknowns = (entry: unknown, max: number) =>
    list(entry, max, (id) => oneOf(id, UNKNOWN_IDS));
  const strings = (entry: unknown, max: number) => list(entry, max, line);
  const hypothesis = (entry: unknown): DraftHypothesis =>
    exact(entry, ["observed", "unknown"])
      ? { observed: oneOf(entry.observed, EVIDENCE_REFS), unknown: oneOf(entry.unknown, UNKNOWN_IDS) }
      : reject();

  if (
    !exact(value, [
      "categories",
      "primary_opportunity_hypothesis",
      "primary_discovery_question",
      "preliminary_fit",
      "top_opportunities",
    ])
  )
    return reject();

  const categories = list(value.categories, ASSESSMENT_CATEGORY_IDS.length, (entry) =>
    exact(entry, [
      "category",
      "observations",
      "unknowns",
      "hypotheses",
      "discovery_questions",
    ])
      ? {
          category: oneOf(entry.category, ASSESSMENT_CATEGORY_IDS),
          observations: list(entry.observations, 8, (observation) =>
            exact(observation, ["type", "citations"])
              ? {
                  type: oneOf(observation.type, OBSERVATION_TYPE_IDS),
                  citations: cites(observation.citations),
                }
              : reject(),
          ),
          unknowns: unknowns(entry.unknowns, 6),
          hypotheses: list(entry.hypotheses, 4, hypothesis),
          discoveryQuestions: strings(entry.discovery_questions, 4),
        }
      : reject(),
  );
  if (
    new Set(categories.map((entry) => entry.category)).size !==
    ASSESSMENT_CATEGORY_IDS.length
  )
    reject();

  const fit = value.preliminary_fit;
  const primary = value.primary_opportunity_hypothesis;
  if (
    !exact(fit, ["signals", "unknowns"]) ||
    !exact(primary, ["category", "observed", "unknown"])
  )
    return reject();
  return {
    categories,
    primary: { category: oneOf(primary.category, ASSESSMENT_CATEGORY_IDS), ...hypothesis({ observed: primary.observed, unknown: primary.unknown }) },
    primaryQuestion: line(value.primary_discovery_question),
    fit: {
      signals: list(fit.signals, 12, (entry) =>
        exact(entry, ["signal", "citations"])
          ? {
              signal: oneOf(entry.signal, FIT_SIGNAL_IDS),
              citations: cites(entry.citations),
            }
          : reject(),
      ),
      unknowns: unknowns(fit.unknowns, 8),
    },
    top: list(value.top_opportunities, 3, (entry) =>
      exact(entry, ["category", "observed", "unknown"])
        ? { category: oneOf(entry.category, ASSESSMENT_CATEGORY_IDS), ...hypothesis({ observed: entry.observed, unknown: entry.unknown }) }
        : reject(),
    ),
  };
}

const normalizedQuote = (quote: string) =>
  quote.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const overlaps = (a: string, b: string) => a.includes(b) || b.includes(a);
const MAX_UNCONFIRMED = 12;

// Keeps only what the retrieved research supports. A quote must be real, must
// not be instruction-like, and must plainly show the exact typed claim; the
// server writes the verified wording. Ambiguous support becomes Unconfirmed.
// Anything else is withheld and counted, never shown as verified.
export function buildAssessmentResult(
  draft: Draft,
  retrieved: readonly RetrievedSource[],
): { result: AssessmentResult; withheld: number } {
  let withheld = 0;
  const unconfirmed: Unconfirmed[] = [];
  // A quote is verbatim in the stored source, or in the source with verified telephone links
  // read as their labels ("Call 555-0100" for "Call [555-0100](tel:+15550100)"). The quote is
  // checked as written and never rewritten.
  const withTelLabels = retrieved.map((item) => ({ ...item, text: resolveTelLinks(item.text) }));
  const verified = (cites: Cite[]) =>
    cites.every((cite) =>
      [retrieved, withTelLabels].some((pool) =>
        citationsVerified({ status: "answered", answer: "-", citations: [cite] }, pool),
      ),
    );
  const resolve = (cites: Cite[]): VerifiedCitation[] =>
    cites.map((cite) => {
      const source = retrieved.find((item) => item.id === cite.source)!;
      return {
        sourceId: source.id,
        sourceUrl: source.sourceUrl,
        chunkId: source.chunkId,
        quote: cite.quote,
      };
    });
  // Real quotes only (verbatim in the stored source), and never text that tries to
  // steer the assessment. Normalization happens later, only to interpret the quote.
  const usable = (cites: Cite[]) =>
    cites.length > 0 &&
    !cites.some((cite) => isInstructionLike(cite.quote)) &&
    verified(cites);
  // The stored text around each quote. Hedges and interface labels are read from here, so a
  // shortened or re-cased quote cannot hide them. A quote that cannot be located is never supported.
  const sourceText = (id: string) => retrieved.find((item) => item.id === id)!.text;
  const contextsFor = (cites: Cite[]) => cites.map((cite) => enclosingText(sourceText(cite.source), cite.quote));
  const unconfirm = (scope: Unconfirmed["scope"], id: string, label: string, cites: Cite[]) => {
    const citations = resolve(cites);
    const repeated = unconfirmed.some(
      (item) => item.scope === scope && item.id === id && item.citations.map((c) => c.quote).join("\u0000") === citations.map((c) => c.quote).join("\u0000"),
    );
    if (!repeated && unconfirmed.length < MAX_UNCONFIRMED) unconfirmed.push({ scope, id, label, citations });
  };
  const keepQuestion = (scope: "primary" | "category") => (value: string) => {
    const ok = discoveryQuestionProblem(value, scope) === null && !isSuspiciousText(value);
    if (!ok) withheld++;
    return ok;
  };
  const unknownsOf = (ids: readonly UnknownId[]): Unknown[] =>
    [...new Set(ids)].map((id) => ({ id, text: unknownText(id) }));

  // 1. Observations: typed, supported by the quote, one per type per category.
  const observationsByCategory = new Map<AssessmentCategoryId, AssessmentResult["categories"][number]["observations"]>();
  for (const definition of ASSESSMENT_CATEGORIES) {
    const entry = draft.categories.find((item) => item.category === definition.id)!;
    const observations: AssessmentResult["categories"][number]["observations"] = [];
    for (const item of entry.observations) {
      const type = observationType(item.type)!;
      const quotes = item.citations.map((cite) => cite.quote);
      if (type.category !== definition.id || !usable(item.citations)) {
        withheld++;
        continue;
      }
      // A number the source's own telephone link contradicts is not shown by that source.
      if (
        type.id === "phone_number_listed" &&
        item.citations.some((cite) => {
          const number = findPhoneNumber(cite.quote);
          return number !== null && phoneNumberContradicted(sourceText(cite.source), number);
        })
      ) {
        withheld++;
        continue;
      }
      const support = observationSupport(type, quotes, contextsFor(item.citations));
      if (support === "ambiguous") {
        unconfirm("observation", type.id, type.label, item.citations);
        continue;
      }
      if (support === "unsupported" || observations.some((seen) => seen.type === type.id)) {
        withheld++;
        continue;
      }
      observations.push({
        type: type.id,
        label: type.label,
        statement: observationStatement(type, quotes),
        citations: resolve(item.citations),
      });
    }
    observationsByCategory.set(definition.id, observations);
  }

  // 2. Signals: a signal counts only when the server accepts it: its quotes show it,
  // they are neither hedged nor interface labels, and no other signal already relies
  // on overlapping text.
  const claimed: { quote: string; signal: FitSignalId }[] = [];
  const signals: AssessmentResult["fit"]["signals"] = [];
  for (const item of draft.fit.signals) {
    const quotes = item.citations.map((cite) => normalizedQuote(cite.quote));
    const shared = quotes.some((quote) =>
      claimed.some((prior) => prior.signal !== item.signal && overlaps(quote, prior.quote)),
    );
    if (!usable(item.citations) || shared) {
      withheld++;
      continue;
    }
    const support = signalSupport(item.signal, item.citations.map((cite) => cite.quote), contextsFor(item.citations));
    if (support === "ambiguous") {
      unconfirm("signal", item.signal, signalLabel(item.signal), item.citations);
      continue;
    }
    if (support === "unsupported") {
      withheld++;
      continue;
    }
    for (const quote of quotes) claimed.push({ quote, signal: item.signal });
    signals.push({
      statement: signalStatement(item.signal),
      citations: resolve(item.citations),
      id: item.signal,
      label: signalLabel(item.signal),
      kind: signalKind(item.signal),
    });
  }

  // 3. Hypotheses: composed by the server from evidence it accepted plus an unknown
  // from the catalog. Evidence the server rejected (or only left Unconfirmed) cannot
  // support one, and an observation type from another category cannot either.
  const accepted = [...observationsByCategory.values()].flat();
  const accept = (ref: string, category?: AssessmentCategoryId): VerifiedStatement | null => {
    const signal = signals.find((item) => item.id === ref);
    if (signal) return signal;
    return accepted.find((item) => item.type === ref && (!category || observationType(ref)!.category === category)) ?? null;
  };
  const grounded = (item: DraftHypothesis, category: AssessmentCategoryId, scoped: boolean): Hypothesis | null => {
    const observed = accept(item.observed, scoped ? category : undefined);
    if (!observed) {
      withheld++;
      return null;
    }
    return {
      // An observation type belongs to one category; a signal keeps the category the model declared.
      category: observationType(item.observed)?.category ?? category,
      statement: composeHypothesis(observed.statement, item.unknown),
      observed: { ref: item.observed, statement: observed.statement, citations: observed.citations },
      unknown: { id: item.unknown, text: unknownText(item.unknown) },
    };
  };

  const categories = ASSESSMENT_CATEGORIES.map((definition) => {
    const entry = draft.categories.find((item) => item.category === definition.id)!;
    const hypotheses: string[] = [];
    for (const item of entry.hypotheses) {
      const kept = grounded(item, definition.id, true);
      if (kept && !hypotheses.includes(kept.statement)) hypotheses.push(kept.statement);
    }
    return {
      category: definition.id,
      label: definition.label,
      observations: observationsByCategory.get(definition.id)!,
      unknowns: unknownsOf(entry.unknowns),
      hypotheses,
      discoveryQuestions: entry.discoveryQuestions.filter(keepQuestion("category")),
    };
  });
  const primary = grounded(draft.primary, draft.primary.category, false);
  const primaryQuestion = keepQuestion("primary")(draft.primaryQuestion)
    ? draft.primaryQuestion
    : null;
  const topOpportunities = draft.top.flatMap((item) => {
    const kept = grounded(item, item.category, false);
    return kept ? [{ ...kept, title: unknownTopic(item.unknown) }] : [];
  });

  // Rewording a claim, moving it to another category, or citing a longer slice
  // of the same passage cannot manufacture a second independent observation.
  const evidence: string[][] = [];
  for (const observation of accepted) {
    const quotes = observation.citations.map((cite) => normalizedQuote(cite.quote));
    if (!evidence.some((seen) => quotes.some((quote) => seen.some((prior) => overlaps(quote, prior)))))
      evidence.push(quotes);
  }
  const { grade, basis } = classifyFit({
    verifiedObservations: evidence.length,
    signalIds: signals.map((item) => item.id),
  });

  // The summary is the accepted observations, joined; the model writes none of it.
  const summarized = accepted.slice(0, 6);
  const seen = new Set<string>();
  const summaryCitations = summarized
    .flatMap((item) => item.citations)
    .filter((cite) => {
      const key = `${cite.sourceId}\u0000${normalizedQuote(cite.quote)}`;
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .slice(0, 8);
  const summary = summarized.length
    ? {
        statement: `From the website's public pages: ${summarized.map((item) => item.statement).join(" ")}`,
        citations: summaryCitations,
      }
    : null;

  const labels = [...new Set(signals.map((item) => item.label))];
  const rationale = [
    FIT_BASIS_TEXT[basis],
    labels.length ? `Verified signals: ${labels.join("; ")}.` : "",
    unconfirmed.length
      ? `${unconfirmed.length} quoted claim${unconfirmed.length === 1 ? " is" : "s are"} Unconfirmed and was not counted.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    withheld,
    result: {
      schemaVersion: 3,
      summary,
      categories,
      unconfirmed,
      primaryOpportunityHypothesis: primary,
      primaryDiscoveryQuestion: primaryQuestion,
      fit: {
        grade,
        basis,
        rubricVersion: FIT_RUBRIC_VERSION,
        rationale,
        signals,
        unknowns: unknownsOf(draft.fit.unknowns),
      },
      topOpportunities,
      sources: retrieved.map((item) => ({
        sourceId: item.id,
        sourceUrl: item.sourceUrl,
        flagged: isInstructionLike(item.text),
        via: item.via,
      })),
      withheld,
    },
  };
}

// Prospect-scoped retrieval over the stored research: one embedding request for
// all category queries, an exact vector search per category, and a full-text
// keyword search per category over the same stored chunks. The two are merged
// under fixed bounds (see mergeAssessmentEvidence). No other provider is called.
export async function retrieveAssessmentSources(
  prospectId: string,
  deps: { database: Pool; embed: Embedder },
  limits: AssessmentRetrievalLimits = ASSESSMENT_RETRIEVAL_LIMITS,
): Promise<RetrievedSource[]> {
  const embeddings = await deps.embed(ASSESSMENT_CATEGORIES.map((item) => item.query));
  if (
    !Array.isArray(embeddings) ||
    embeddings.length !== ASSESSMENT_CATEGORIES.length ||
    !embeddings.every(isResearchEmbedding)
  )
    throw new Error("Embedding provider returned an invalid response.");
  const perCategory: { vector: EvidenceCandidate[]; keyword: EvidenceCandidate[]; keywordSlots?: number }[] = [];
  for (const [position, category] of ASSESSMENT_CATEGORIES.entries()) {
    const vector = await searchResearchChunks(
      {
        prospectId,
        embedding: embeddings[position]!,
        limit: Math.min(20, limits.perCategory * VECTOR_CANDIDATE_FACTOR),
      },
      deps.database,
    );
    const slots = limits.keywordPerCategory ? (category.keywordSlots ?? limits.keywordPerCategory) : 0;
    const keyword = slots
      ? await searchResearchChunksByKeyword(
          {
            prospectId,
            query: category.keywords,
            limit: Math.min(20, slots * KEYWORD_CANDIDATES_PER_SLOT),
          },
          deps.database,
        )
      : [];
    perCategory.push({ vector, keyword, keywordSlots: slots });
  }
  return mergeAssessmentEvidence(perCategory, limits).map(({ candidate, via }, position) => ({
    id: `S${position + 1}`,
    chunkId: candidate.id,
    sourceUrl: candidate.sourceUrl,
    text: candidate.content,
    via,
  }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HELD_ERROR =
  "Assessment provider outcome uncertain; inspect before another paid run.";
export const UNUSABLE_ERROR =
  "Assessment response was unusable; no assessment was saved.";

// Reserves the single paid run for the prospect's current evidence, retrieves
// from stored embeddings (Firecrawl never runs), asks the assessor once, then
// persists only server-verified content. An uncertain provider outcome is held
// for a human and never retried automatically.
export async function generateLeadIntakeAssessment(
  prospectId: string,
  deps: { database: Pool; embed: Embedder; assess: Assessor; model: string },
): Promise<{ assessmentId: string; reused: boolean }> {
  if (!UUID.test(prospectId)) throw new Error("Valid prospect ID required.");
  const reservation = await reserveAssessment(prospectId.toLowerCase(), {
    database: deps.database,
    model: deps.model,
  });
  if (reservation.kind === "existing")
    return { assessmentId: reservation.id, reused: true };

  let sources: RetrievedSource[] = [];
  let raw: unknown;
  try {
    sources = await retrieveAssessmentSources(prospectId.toLowerCase(), deps);
    if (sources.length)
      raw = await deps.assess(
        sources.map(({ id, sourceUrl, text: excerpt }) => ({
          id,
          sourceUrl,
          text: excerpt,
        })),
      );
  } catch (error) {
    await endAssessmentWithoutResult(
      reservation.id,
      "needs_review",
      HELD_ERROR,
      deps.database,
    ).catch(() => {});
    throw error;
  }

  let built: ReturnType<typeof buildAssessmentResult>;
  try {
    if (!sources.length)
      throw new AssessmentOutputError("No research could be retrieved.");
    built = buildAssessmentResult(
      parseAssessmentDraft(raw, sources.map((item) => item.id)),
      sources,
    );
    // The research this was built from must still be the research it was reserved for.
    const now = await currentEvidenceVersion(prospectId.toLowerCase(), deps.database);
    if (now?.fingerprint !== reservation.fingerprint)
      throw new AssessmentOutputError("Research changed during the assessment.");
  } catch (error) {
    await endAssessmentWithoutResult(
      reservation.id,
      "failed",
      UNUSABLE_ERROR,
      deps.database,
    ).catch(() => {});
    throw error;
  }
  await completeAssessment(
    reservation.id,
    built.result,
    built.withheld,
    deps.database,
  );
  return { assessmentId: reservation.id, reused: false };
}
