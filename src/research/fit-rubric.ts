import {
  EMERGENCY_SERVICE,
  judgeQuote,
  lintable,
  normalizeScraped,
  type QuoteContexts,
  type Support,
} from "./intake-evidence.js";

// The Relay prospect-fit rubric, carried over from the original n8n "Relay
// Prospecting Agent" (FIT SCORING, FIT EVIDENCE RULE, HYPOTHESIS STANDARD,
// DISCOVERY QUESTION STANDARD). It is configuration plus pure functions, so the
// A/B/C grade is derived by the server from verified signals instead of being
// taken from the model. Changing a threshold, signal, or lint is a rubric
// change: bump FIT_RUBRIC_VERSION. The version is part of an assessment's
// fingerprint, so a bump makes earlier assessments outdated and regenerable.
//
// Deliberate differences from the n8n agent:
//  - The model reports quoted signals and the server derives A/B/C; the n8n
//    agent returned its own "fit" and "fitReason".
//  - A needs at least FIT_THRESHOLDS.minComplexitySignalsForA distinct verified
//    signals. n8n lists signals that "may include" without a count, so the count
//    is Relay's own choice. One signal is B.
//  - Complexity and affirmative limited-relevance evidence together give B, never
//    A or C, until discovery resolves the conflict.
//  - Two n8n catch-alls are not signals because they cannot be quoted:
//    "operational complexity worth understanding" (A) and "limited reason to
//    believe response/follow-up complexity matters" (C, which would infer
//    weakness from silence). "Explicit after-hours availability" is folded into
//    the urgent-service signal.
//  - Evidence must also pass signalSupport: the cited quote itself has to show
//    the signal, and one quote cannot back two signals.
//  - Hypotheses must use the "worth understanding whether" style framing or a
//    may/might/could modal, and must not assert a deficiency.
//  - The model never writes a verified fact. It names a typed signal and cites
//    text; the server checks that the quote supports that signal, writes the
//    wording itself, and treats hedged or partial support as Unconfirmed.
export const FIT_RUBRIC_VERSION = "n8n-prospecting-fit-v5";

export type FitGrade = "A" | "B" | "C" | "Unassessed";

// FIT SCORING "A" signals and the FIT EVIDENCE RULE's good evidence. Each must
// be shown by a quoted public statement.
// The text a cited quote must contain to show a signal. These are gates on what
// the quote says, not proof of the claim; they stop an unrelated quote from
// being attached to a signal. They err toward withholding.
const CHANNELS: RegExp[] = [
  /\b(?:call|phone|telephone)\b/i,
  /\b(?:form|get a quote|request (?:an? |your )?(?:\w+ ){0,2}(?:quote|estimate|service|callback))\b/i,
  /\bchat\b/i,
  /\b(?:book(?:ing)?|schedul(?:e|ing)|appointments?)\b/i,
  /\be-?mail\b/i,
];
const PHONE_NUMBER = /\b\d{3}[-. ]\d{3,4}(?:[-. ]\d{4})?\b/g;
const SERVICE_WORDS =
  /\b(?:repair|installation|install|maintenance|replacement|inspection|cleaning|plumbing|heating|cooling|electrical|roofing|drain|remodeling)\b/gi;
const distinct = (text: string, pattern: RegExp) =>
  new Set([...text.matchAll(pattern)].map((match) => match[0].toLowerCase())).size;

export const COMPLEXITY_SIGNALS = [
  {
    id: "urgent_or_emergency_service",
    // A high-stakes signal: it must come from a statement the business wrote, not a label.
    requiresStatement: true,
    shows: (q: string) =>
      // Statements that the business offers urgent service, not words that merely appear. A form option
      // such as "Urgent / call today", "Same-day appointment", or "Urgent call back" says how a visitor
      // can describe a request, so it needs an offer of service: an emergency service, an around-the-clock
      // service, or a named same-day or after-hours service.
      EMERGENCY_SERVICE.test(q) ||
      /\b(?:24\s*[\/-]\s*7|24[- ]hours?|round[- ]the[- ]clock|around the clock)\s+(?:service|support|repair|dispatch|availability)\b|\b(?:service|calls?)\s+(?:is|are)\s+(?:available|answered)\s+(?:24\s*[\/-]\s*7|24 hours|around the clock)\b|\b(?:after[- ]hours?|same[- ]day|weekend|night(?:time)?)\s+(?:service|repairs?|heating|cooling)\b|\bon[- ]call\s+(?:technicians?|crew|team|service)\b/i.test(q),
    statement: "The website refers to urgent, emergency, or after-hours service.",
    label: "Urgent, emergency, or explicit after-hours service",
    description:
      "time-sensitive services, emergency requests, or explicitly stated after-hours availability",
  },
  {
    id: "multiple_intake_paths",
    // Meant to be shown by more than one quote (a phone number in one, a form in another).
    joined: true,
    shows: (q: string) =>
      CHANNELS.filter((channel) => channel.test(q)).length >= 2 ||
      distinct(q, PHONE_NUMBER) >= 2,
    statement: "The website shows more than one way to reach the business.",
    label: "Multiple customer-intake paths",
    description:
      "more than one way to reach the business, such as multiple phone numbers, forms plus phone, or forms plus chat or booking",
  },
  {
    id: "multiple_locations",
    shows: (q: string) =>
      /\b(?:multiple|several|two|three|four|many)\s+(?:locations|offices|branches|shops|stores|service centers?)\b|\b(?:locations|offices|branches|shops|stores|service centers?)\s+in\s+[^.\n]+\s+and\s+[^.\n]+/i.test(q),
    statement: "The website refers to more than one office or location.",
    label: "Multiple offices or locations",
    description: "more than one office or location",
  },
  {
    id: "broad_service_territory",
    shows: (q: string) =>
      /\b(?:statewide|nationwide|regional|metro area|multiple counties|several counties|surrounding areas|service areas)\b|\b(?:serving|serves)\s+[^.\n]+\s+and\s+[^.\n]+/i.test(q),
    statement: "The website describes a broad or multi-area service territory.",
    label: "Broad service territory",
    description: "a broad or multi-area geographic service territory",
  },
  {
    id: "multiple_service_categories",
    shows: (q: string) =>
      distinct(q, SERVICE_WORDS) >= 2 || /\bresidential\b[\s\S]*\bcommercial\b|\bcommercial\b[\s\S]*\bresidential\b/i.test(q),
    statement: "The website describes several distinct service categories.",
    label: "Multiple service categories",
    description: "several distinct service categories",
  },
  {
    id: "visible_team_structure",
    shows: (q: string) =>
      /\b(?:our team|team members?|owner|president|general manager|operations manager|office manager|sales manager|dispatchers?|technicians|estimators?|founder|director|leadership|staff)\b/i.test(q),
    statement: "The website shows a team or leadership structure.",
    label: "Visible team structure",
    description: "a publicly visible team or leadership structure",
  },
  {
    id: "coordination_or_handoffs",
    shows: (q: string) =>
      /\b(?:dispatch\w*|rout(?:e|ed|ing)|assign\w*|coordinat\w*|hand-?off|estimators?|referr\w*|follow-?up|call-?back)\b|\bwe(?:'ll| will) (?:call|contact|get back|reach out)\b/i.test(q),
    statement: "The website refers to dispatch, routing, or coordination between people.",
    label: "Requests that may need routing or handoffs",
    description:
      "customer requests that appear to require coordination, routing, or handoffs between people or teams",
  },
  {
    id: "visible_demand_generation",
    shows: (q: string) =>
      /\b(?:reviews?|testimonials?|rated|stars?|awards?|advertis\w*|promotions?|coupons?|special offers?|financing)\b/i.test(q),
    statement: "The website shows demand-generation activity such as reviews, promotions, or financing.",
    label: "Visible demand-generation activity",
    description: "strong, publicly visible demand-generation activity",
  },
] as const;

// FIT SCORING "C" reasons. Each needs AFFIRMATIVE public evidence. A capability
// that is merely not mentioned is an unknown and can never support a C.
export const LIMITED_RELEVANCE_SIGNALS = [
  {
    id: "limited_inbound_demand",
    requiresStatement: true,
    shows: (q: string) => /\b(?:referral[- ]only|by referral only|invitation[- ]only)\b/i.test(q),
    statement: "The website states that the business works by referral or limits new customers.",
    label: "Affirmative evidence of little inbound demand",
    description:
      "a public statement showing little meaningful inbound customer demand",
  },
  {
    id: "very_simple_intake",
    requiresStatement: true,
    // The business says its own way of being reached is exclusive: "the only way to reach us",
    // "by phone only". A bare "only" or "call only during business hours" is not that.
    shows: (q: string) =>
      /\b(?:the|our) only (?:way|method|means) (?:to|of) (?:reach|contact|book|schedule|request)\b|\bby (?:phone|appointment|referral) only\b|\bwe (?:only|exclusively) (?:take|accept|book|schedule) (?:requests |bookings |appointments |jobs )?(?:by|through|via) (?:phone|referral|appointment)\b/i.test(q),
    statement: "The website describes a single, exclusive way to reach the business.",
    label: "Affirmatively simple intake",
    description:
      "a public statement showing genuinely simple intake, such as stating that one channel is the only way customers reach the business",
  },
  {
    id: "poor_economic_fit",
    requiresStatement: true,
    // Self-description only: "We are a volunteer-run nonprofit". Donating to one, or "no cost to
    // customers" for an estimate, says nothing about the business's own economics.
    shows: (q: string) =>
      /\b(?:we are (?:an? )?(?:all[- ])?volunteer|volunteer[- ](?:run|led|based)|we are (?:an? )?non-?profit|we are a (?:free|charitable) (?:clinic|service)|our (?:service|clinic) is (?:entirely )?free of charge)\b/i.test(q),
    statement: "The website describes a volunteer, nonprofit, or free-of-charge operation.",
    label: "Affirmative evidence of poor economic fit",
    description: "a public statement showing poor apparent economic fit",
  },
  {
    id: "not_relevant_to_offer",
    requiresStatement: true,
    // Self-description of a different kind of business: "We are an online store". A product, a
    // brand, or a supply relationship ("authorized dealer", "restaurant supply") is not that.
    shows: (q: string) =>
      /\bwe (?:are|operate) (?:an? )?(?:online store|e-?commerce (?:store|business|company)|restaurant(?!\s+(?:supply|equipment|hvac|refrigeration|service|repair|install\w*))|software company|saas company|retailer|wholesaler)\b/i.test(q),
    statement: "The website describes a business that is not a typical service business.",
    label: "Affirmative evidence of little relevance to Relay's offer",
    description:
      "a public statement showing the business is not the kind of service business Relay's current offer serves",
  },
] as const;

export type ComplexitySignalId = (typeof COMPLEXITY_SIGNALS)[number]["id"];
export type LimitedRelevanceSignalId =
  (typeof LIMITED_RELEVANCE_SIGNALS)[number]["id"];
export type FitSignalId = ComplexitySignalId | LimitedRelevanceSignalId;

const SIGNALS = [...COMPLEXITY_SIGNALS, ...LIMITED_RELEVANCE_SIGNALS];
export const FIT_SIGNAL_IDS = SIGNALS.map((signal) => signal.id) as [
  FitSignalId,
  ...FitSignalId[],
];
export const signalLabel = (id: FitSignalId): string =>
  SIGNALS.find((signal) => signal.id === id)!.label;
export const signalKind = (id: FitSignalId): "complexity" | "limited_relevance" =>
  COMPLEXITY_SIGNALS.some((signal) => signal.id === id)
    ? "complexity"
    : "limited_relevance";

export const FIT_THRESHOLDS = {
  // Fewer verified category observations than this leaves the prospect Unassessed.
  minVerifiedObservations: 2,
  // Distinct verified complexity signals needed for A. One signal is a plausible
  // fit whose economic and operational picture is still unclear: B.
  minComplexitySignalsForA: 2,
} as const;

export type FitBasis =
  | "insufficient_evidence"
  | "strong_complexity"
  | "some_complexity"
  | "mixed_evidence"
  | "limited_relevance"
  | "signals_unclear";

export const FIT_BASIS_TEXT: Record<FitBasis, string> = {
  insufficient_evidence: `Fewer than ${FIT_THRESHOLDS.minVerifiedObservations} verified observations were found in the retrieved research, so there is not enough verified evidence for a defensible A, B, or C.`,
  strong_complexity: `Several distinct signals of operational complexity are verified in the public research (${FIT_THRESHOLDS.minComplexitySignalsForA} or more), which is a strong reason to investigate Relay. Economic value and the internal process are still unknown.`,
  some_complexity:
    "One signal of operational complexity is verified in the public research. This is a plausible fit, but economic and operational signals are less clear, so discovery should come before heavy prioritization.",
  mixed_evidence:
    "The public research verifies both a signal of operational complexity and affirmative evidence of limited relevance. Treated as a plausible fit until discovery resolves the conflict.",
  limited_relevance:
    "The public research affirmatively shows limited relevance, with no verified signal of operational complexity. This is a weak early fit, provisional until discovery.",
  signals_unclear:
    "Verified observations exist, but none shows a rubric signal of operational complexity or of limited relevance. What the website does not show is unknown, not a weakness. This is a plausible fit with unclear signals.",
};

// Pure: the grade follows from counts of verified evidence only.
export function classifyFit(input: {
  verifiedObservations: number;
  signalIds: Iterable<FitSignalId>;
}): { grade: FitGrade; basis: FitBasis } {
  if (input.verifiedObservations < FIT_THRESHOLDS.minVerifiedObservations)
    return { grade: "Unassessed", basis: "insufficient_evidence" };
  const distinct = new Set(input.signalIds);
  const complexity = [...distinct].filter((id) => signalKind(id) === "complexity").length;
  const limited = distinct.size - complexity;
  if (complexity && limited) return { grade: "B", basis: "mixed_evidence" };
  if (complexity >= FIT_THRESHOLDS.minComplexitySignalsForA)
    return { grade: "A", basis: "strong_complexity" };
  if (complexity) return { grade: "B", basis: "some_complexity" };
  if (limited) return { grade: "C", basis: "limited_relevance" };
  return { grade: "B", basis: "signals_unclear" };
}

// The model never writes a fact, so there is no fact lint: a signal's wording is fixed here and
// its support is decided by what the cited quotes say. Quotes are interpreted in normalized form.
// One quote must show the claim (only signals marked `joined` are shown by several quotes, one per
// channel, and then every one of them must stand). Hedges, interface labels, and (for high-stakes
// signals) the need for a real statement are judged against everywhere the quote occurs in its
// stored source, so a shortened or re-cased quote cannot hide them.
export function signalSupport(
  id: FitSignalId,
  quotes: readonly string[],
  contexts?: QuoteContexts,
): Support {
  const signal = SIGNALS.find((item) => item.id === id)! as {
    shows: (q: string) => boolean;
    joined?: true;
    requiresStatement?: true;
  };
  const normalized = quotes.map(normalizeScraped);
  const showing = signal.joined
    ? signal.shows(normalized.join("\n"))
      ? quotes.map((_, index) => index)
      : []
    : normalized.flatMap((quote, index) => (signal.shows(quote) ? [index] : []));
  if (!showing.length) return "unsupported";
  const verdicts = showing.map((index) =>
    judgeQuote(quotes[index]!, contexts ? contexts[index] : undefined, { requiresStatement: signal.requiresStatement }),
  );
  if (signal.joined) return verdicts.every((verdict) => verdict === "supported") ? "supported" : "ambiguous";
  return verdicts.includes("supported") ? "supported" : "ambiguous";
}
export const signalStatement = (id: FitSignalId): string =>
  SIGNALS.find((signal) => signal.id === id)!.statement;

// DISCOVERY QUESTION STANDARD: a specific, answerable process question that
// does not accuse and does not lead with technology or a sales pitch.
// "After someone calls, who ..." leads with a time clause, so the question itself must follow it.
const INTERROGATIVE =
  /^(?:(?:what|who|how|when|where|which|do|does|is|are|can|if|once)\b|after\b(?=[^?.!,]*[a-z])[^?.!]{3,200}?,\s*(?:what|who|how|when|where|which|do|does|is|are|can)\b)/i;
const TECHNICAL_OR_PITCH =
  /\b(?:ai|artificial intelligence|automation|automate[sd]?|(?:ai|chat|virtual) agents?|chatbots?|n8n|apis?|webhooks?|interested in|demo|our solution)\b/i;
// The primary question exposes the process, not the tooling.
const TOOLING = /\b(?:crm|software|apps?|platforms?|tools?)\b/i;
const ACCUSATORY =
  /\b(?:why (?:don'?t|aren'?t|can'?t|won'?t)|you (?:never|fail|ignore|lose|miss)|(?:are|is) (?:you|they|your team) (?:losing|missing|ignoring)|too slow|ignor\w*|poor(?:ly)?|slow(?:ly)? to|losing|missed|missing|nobody|no one)\b/i;
// A question may not carry an invented figure, or presuppose a failure the site never showed.
// ("24/7" is a service description, not a figure about the business, so it is set aside first.)
const FIGURES = /\d|\bpercent\b|%|\$|\b(?:monthly|weekly|daily|per (?:month|week|day|year)|dozens?|hundreds?|thousands?|twenty|thirty|forty|fifty|half of|most of)\b/i;
const PRESUPPOSES_FAILURE =
  /\b(?:voicemail|forget|forgets|forgot|forgotten|drops?|dropped|goes? elsewhere|go elsewhere|slow|lazy|neglect\w*|abandon\w*|lose|loses|lost|complain\w*|overwhelmed|backlog|falls? through|cracks|going cold|on hold|slipping|slips? through|unanswered|no reply|never get)\b/i;
export const DISCOVERY_QUESTION_LIMITS = { min: 15, max: 300 } as const;

// The reason a question fails the standard, or null when it passes. Category
// questions may ask about tools (the CRM category must); the primary may not.
export function discoveryQuestionProblem(
  value: string,
  scope: "primary" | "category" = "primary",
): string | null {
  const question = lintable(value).trim();
  if (
    question.length < DISCOVERY_QUESTION_LIMITS.min ||
    question.length > DISCOVERY_QUESTION_LIMITS.max
  )
    return "length";
  if (!question.endsWith("?") || question.indexOf("?") !== question.length - 1)
    return "not_one_question";
  if (!INTERROGATIVE.test(question)) return "not_a_process_question";
  if (
    TECHNICAL_OR_PITCH.test(question) ||
    (scope === "primary" && TOOLING.test(question))
  )
    return "leads_with_technology";
  if (ACCUSATORY.test(question) || PRESUPPOSES_FAILURE.test(question)) return "accusatory";
  if (FIGURES.test(question.replace(/\b24\s*[\/-]\s*7\b/g, ""))) return "contains_figure";
  return null;
}

// The rubric as model instructions, generated from the same configuration the
// server enforces so the two cannot drift apart.
export function fitRubricInstructions(): string {
  const list = (items: readonly { id: string; description: string }[]) =>
    items.map((item) => `${item.id} (${item.description})`).join("; ");
  return (
    `FIT RUBRIC ${FIT_RUBRIC_VERSION}. You do not assign A, B, or C, and you never write a factual sentence: the server derives the grade from the signals it validates and writes all verified wording itself. ` +
    "Report candidate signals by id only, each with citations whose quote itself shows that signal. The server checks the quote against the signal, and hedged, conditional, or partial support is Unconfirmed, not verified. One quote can back only one signal. " +
    `Complexity signals: ${list(COMPLEXITY_SIGNALS)}. ` +
    `Limited-relevance signals: ${list(LIMITED_RELEVANCE_SIGNALS)}. ` +
    "Report a limited-relevance signal only for AFFIRMATIVE evidence. A capability that is not mentioned is an unknown, never a reason for weak fit. " +
    "Name unknowns by id only. Economic value, lead volume, booking rate, and response time are unknowns unless an excerpt directly says otherwise; never state them yourself. " +
    "Interface text such as dropdown options, menu items, or button labels (often joined without spaces, like \"availableThis\") shows what a form offers, not what the business does: do not cite it for a signal such as emergency service. " +
    "Never put an internal id (anything_with_underscores) in a discovery question. " +
    "HYPOTHESIS STANDARD: observed public evidence plus an operational unknown is a discovery opportunity. A hypothesis is just two ids: one observed evidence id (an observation type or signal you reported, which the server accepted) and one unknown id. You do not write the sentence: the server composes it in the original form, observed evidence followed by \"so it may be worth understanding\" the unknown, so it can never state a conclusion or turn an unknown into a claim. A hypothesis that cites evidence the server rejected is withheld. " +
    "DISCOVERY QUESTION STANDARD: the primary discovery question exposes the operational process behind the strongest observed signal. It is one specific question that an owner or manager can easily answer, does not accuse the business of a problem, does not mention AI, automation, or software tools, does not use words like missing, missed, or losing, and asks what actually happens (routing, ownership, response, follow-up, or visibility). " +
    'Good: "When someone uses the web form instead of calling, what happens from there?" or "How do you make sure an urgent request reaches the right person after hours?" Bad: "Are you interested in automation?" '
  );
}
