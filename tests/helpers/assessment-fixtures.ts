import { RESEARCH_EMBEDDING_DIMENSIONS, type Embedder } from "../../src/research/openai-embeddings.js";
import { ASSESSMENT_CATEGORY_IDS } from "../../src/research/openai-assessor.js";

export const PHONE_QUOTE = "Call 555-0100 to reach our office.";
export const ONLY_PHONE_QUOTE = "Call 555-0100, the only way to reach us.";
export const FORM_QUOTE = "Request a quote with the contact form.";
export const EMERGENCY_QUOTE = "Technicians answer emergency calls 24 hours a day.";
export const FIXTURE_PAGE = [
  "# Riverbend Comfort",
  PHONE_QUOTE,
  ONLY_PHONE_QUOTE,
  FORM_QUOTE,
  EMERGENCY_QUOTE,
].join("\n\n");

// Deterministic bag-of-words vectors: texts sharing words are close.
export function fakeVector(text: string): number[] {
  const vector = new Array<number>(RESEARCH_EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = 0.001;
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 2166136261;
    for (const character of word) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    vector[1 + ((hash >>> 0) % (RESEARCH_EMBEDDING_DIMENSIONS - 1))]! += 1;
  }
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}

export function fakeEmbedder() {
  const calls: string[][] = [];
  const embed: Embedder = async (texts) => {
    calls.push(texts);
    return texts.map(fakeVector);
  };
  return { embed, calls };
}

type Source = { id: string; text: string };
type RawDraft = Record<string, any>;

// A well-formed raw model response in the typed shape: evidence types, signal
// ids, unknown ids, and citations copied from the fixture page. The model writes
// no verified wording. It reports two validated complexity signals, so the
// server grades it A.
export function sampleDraft(sources: readonly Source[]): RawDraft {
  const idFor = (quote: string) => {
    const source = sources.find((item) => item.text.includes(quote));
    if (!source) throw new Error(`No retrieved source contains: ${quote}`);
    return source.id;
  };
  // Fresh objects per use, so a test can corrupt one citation in isolation.
  const cite = (quote: string) => ({ source: idFor(quote), quote });
  const phone = () => [cite(PHONE_QUOTE)];
  const form = () => [cite(FORM_QUOTE)];
  const emergency = () => [cite(EMERGENCY_QUOTE)];
  // A hypothesis is two ids; the server composes the sentence.
  const opportunity = (category: string, observed: string, unknown: string) => ({ category, observed, unknown });
  return {
    categories: ASSESSMENT_CATEGORY_IDS.map((category) => ({
      category,
      observations:
        category === "phone_intake"
          ? [{ type: "phone_number_listed", citations: phone() }]
          : category === "after_hours"
            ? [{ type: "emergency_service_stated", citations: emergency() }]
            : [],
      unknowns: ["lead_volume"],
      hypotheses:
        category === "phone_intake"
          ? [{ observed: "phone_number_listed", unknown: "first_to_see_request" }]
          : category === "website_forms"
            ? [{ observed: "multiple_intake_paths", unknown: "forms_calls_same_system" }]
            : category === "after_hours"
              ? [{ observed: "emergency_service_stated", unknown: "after_hours_handling" }]
              : [],
      discovery_questions: [`What happens to a request that arrives through ${category.replaceAll("_", " ")}?`],
    })),
    primary_opportunity_hypothesis: {
      category: "after_hours",
      observed: "emergency_service_stated",
      unknown: "forms_calls_same_system",
    },
    primary_discovery_question: "When someone uses the web form instead of calling, what happens from there?",
    preliminary_fit: {
      signals: [
        { signal: "urgent_or_emergency_service", citations: emergency() },
        { signal: "multiple_intake_paths", citations: [...phone(), ...form()] },
      ],
      unknowns: ["lead_volume", "economic_value"],
    },
    top_opportunities: [
      opportunity("after_hours", "urgent_or_emergency_service", "after_hours_handling"),
      opportunity("website_forms", "phone_number_listed", "forms_calls_same_system"),
      opportunity("follow_up", "emergency_service_stated", "followup_ownership"),
    ],
  };
}
