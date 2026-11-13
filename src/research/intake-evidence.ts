// Approved, typed intake evidence. The model never writes a verified fact: it
// names a type from this catalog and cites retrieved text. The server checks
// that the cited quote actually supports that exact type, then writes the
// wording itself, using only values extracted from the quote.
export const ASSESSMENT_CATEGORY_IDS = [
  "phone_intake",
  "website_forms",
  "online_booking",
  "after_hours",
  "follow_up",
  "crm_integrations",
] as const;
export type AssessmentCategoryId = (typeof ASSESSMENT_CATEGORY_IDS)[number];

// supported: the quote shows the claim. ambiguous: related wording is present
// but the claim is not fully shown or the quote hedges it, so it is Unconfirmed.
// unsupported: the quote does not bear on the claim.
export type Support = "supported" | "ambiguous" | "unsupported";

// Zero-width and other format characters are removed so a banned word cannot be split.
export const lintable = (value: string) =>
  value
    .normalize("NFKC")
    .replace(/[\p{Cf}­]/gu, "")
    .replace(/[‘’]/g, "'");

// Scraped page text often joins adjacent elements without a space ("availableThis",
// "HVACCommercial"). Validators interpret a spaced copy of a quote. Citations are
// never checked against it: a quote must still appear verbatim in the stored source.
export const normalizeScraped = (value: string) =>
  lintable(value)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
// How many words the scraper glued together. Two or more means the text is a run of
// interface labels (dropdown options, menu items), not a sentence the business wrote.
export const joinedWordCount = (value: string) =>
  (lintable(value).match(/[a-z](?=[A-Z])|[A-Z](?=[A-Z][a-z])/g) ?? []).length;
// A short run of items (options in a dropdown, entries in a menu or footer), however they are
// separated: line breaks, bullets, pipes, slashes with spaces, semicolons, or commas. Three or
// more brief segments, at least three of them plain labels (no digits, colon, or @, so a
// "Phone: 555-0100" contact block is not a list). Commas separate items only when asking whether
// a high-stakes statement is really a list: a place list ("Serving Linden, Rahway, and Clark")
// is an ordinary sentence for every other claim.
const isListLike = (value: string, commas = false) => {
  const segments = lintable(value)
    .split(commas ? /\s*[|;•·]\s*|\s+\/\s+|\n+|,\s*/ : /\s*[|;•·]\s*|\s+\/\s+|\n+/)
    .map((segment) => segment.trim().replace(/^[-*•·]\s+|^\d+[.)]\s+/, ""))
    .filter(Boolean);
  return (
    segments.length >= 3 &&
    segments.every((segment) => segment.length <= 32) &&
    segments.filter((segment) => !/[:\d@]/.test(segment)).length >= 3
  );
};
export const isUiFragment = (value: string) => joinedWordCount(value) >= 2 || isListLike(value);

// A statement the business wrote: a sentence of at least five words, or a heading of at least
// three, that is not a question and not a list. A label, an option, or a menu item is not one.
// High-stakes claims (emergency service, a fit signal) must come from a statement, which defeats
// option lists however they are laid out (separate lines, bullets, pipes, blank lines).
export function isStatement(sentence: string): boolean {
  const text = lintable(sentence).trim().replace(/^[-*•·]\s+|^\d+[.)]\s+/, "");
  if (!text || /\?["')\]]*$/.test(text) || isListLike(text, true)) return false;
  const heading = /^#{1,6}\s+/.test(text);
  const words = text.replace(/^#{1,6}\s+/, "").split(/\s+/).filter(Boolean);
  return heading ? words.length >= 3 : words.length >= 5;
}

// A Markdown telephone link is read as its visible label only when the label is a plain phone
// number and the link dials that same number (an optional leading country code 1 aside). A link
// whose label and destination disagree, or whose destination carries parameters, is never
// resolved, so a link cannot make one number appear to be another. Resolving is for interpreting
// text; a stored quote is never rewritten.
const TEL_LINK = /\[([^\[\]\r\n]+)\]\(tel:([^\s()]*)\)/gi;
const TEL_LABEL = /^\+?[\d\s().\u2010-\u2015-]{10,24}$/;
const TEL_TARGET = /^\+?[\d().-]{10,24}$/;
const digitsOf = (value: string) => value.replace(/\D/g, "");
const telLinkDials = (label: string, target: string): boolean => {
  if (!TEL_LABEL.test(label.trim()) || !TEL_TARGET.test(target)) return false;
  const shown = digitsOf(label);
  const dialed = digitsOf(target);
  const national = shown.length === 10 ? shown : shown.length === 11 && shown.startsWith("1") ? shown.slice(1) : null;
  // The "+1" country code, or a bare national number. "+7325..." is another country's number.
  return national !== null && (dialed === `1${national}` || (dialed === national && !target.startsWith("+")));
};
// Link syntax is matched after NFKC, so a full-width scheme or digits cannot hide a mismatch.
export const resolveTelLinks = (value: string): string => {
  const text = value.normalize("NFKC");
  if (!/tel:/i.test(text)) return value;
  return text.replace(TEL_LINK, (link, label: string, target: string) => (telLinkDials(label, target) ? label.trim() : link));
};
// True when text still holds a telephone link or scheme after resolving: one that does not dial
// the number it shows.
export const hasUnresolvedTel = (value: string): boolean => /\btel:/i.test(resolveTelLinks(value));
// True when a telephone link in the source presents this number but does not plainly dial it. A
// label with extra words ("Call 732-551-7848") is fine so long as the link dials that number.
export function phoneNumberContradicted(source: string, number: string): boolean {
  const wanted = digitsOf(number);
  for (const match of source.normalize("NFKC").matchAll(TEL_LINK)) {
    const dialsIt = TEL_TARGET.test(match[2]!) && digitsOf(match[2]!).endsWith(wanted);
    if (digitsOf(match[1]!).includes(wanted) && !dialsIt) return true;
  }
  return false;
}

// Markdown emphasis, brackets, and link destinations never change what a sentence says, so they
// are removed when finding a quote in its source. Case and line breaks are kept.
const WEBSITE_LINK = /\[([^\[\]\r\n]+)\]\(https?:\/\/[^\s()]+\)/gi;
// What a person should read for a stored quote: complete website links and verified telephone
// links show their label. Nothing else is interpreted, and the result is still escaped as text.
export const readableQuote = (value: string): string => resolveTelLinks(value).replace(WEBSITE_LINK, "$1");
const stripMarkup = (value: string) =>
  resolveTelLinks(lintable(value))
    .replace(WEBSITE_LINK, "$1")
    .replace(/[“”]/g, '"')
    .replace(/[*_`\[\]]/g, "")
    .replace(/[ \t]+/g, " ");
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isLabelLine = (line: string) => line.trim().length > 0 && line.trim().length <= 40 && !/[.!?]$/.test(line.trim());

// One place a quote occurs in its stored source. sentence is the sentence or line it sits in
// (what a statement test looks at); scope is that plus the label or heading line just above it
// and any neighbouring label lines (what hedge and interface-label tests look at).
export type Occurrence = { sentence: string; scope: string };
const MAX_OCCURRENCES = 20;
const MAX_WINDOW = 600;

// Every place the quote occurs in its stored source, so a hedge or interface list cannot hide
// outside the quote: a shortened, re-cased, or re-punctuated quote is found all the same. Null
// when the quote cannot be found (the caller then treats the evidence as ambiguous, never as
// supported).
export function enclosingText(source: string, quote: string): Occurrence[] | null {
  const text = stripMarkup(source);
  const words = stripMarkup(quote).trim().replace(/[.!?]+$/, "").split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const pattern = new RegExp(words.map(escapeRegExp).join("\\s+"), "gi");
  const lines = text.split("\n");
  const found: Occurrence[] = [];
  for (const match of text.matchAll(pattern)) {
    if (found.length >= MAX_OCCURRENCES) break;
    const start = match.index!;
    const end = start + match[0].length;
    let left = 0;
    for (const boundary of text.slice(0, start).matchAll(/[.!?]\s|\n/g)) left = boundary.index! + boundary[0].length;
    const next = /[.!?](?=\s|$)|\n/.exec(text.slice(end));
    const right = next ? end + next.index + (next[0] === "\n" ? 0 : 1) : text.length;
    let sentence = text.slice(left, right).trim();
    // An unpunctuated run is windowed symmetrically around the quote, never from its start.
    if (sentence.length > MAX_WINDOW) {
      const center = (start + end) / 2;
      sentence = text.slice(Math.max(left, Math.floor(center - MAX_WINDOW / 2)), Math.min(right, Math.ceil(center + MAX_WINDOW / 2))).trim();
    }
    let scope = sentence;
    const lineIndex = text.slice(0, start).split("\n").length - 1;
    // A heading or label line directly above (a "Coming soon" banner) bears on the line below it.
    for (let i = lineIndex - 1; i >= Math.max(0, lineIndex - 3); i--) {
      if (!lines[i]!.trim()) continue;
      if (isLabelLine(lines[i]!)) scope = `${lines[i]!.trim()}\n${scope}`;
      break;
    }
    // A label line sees its neighbouring label lines (an option list kept one option per line).
    if (isLabelLine(sentence)) {
      let from = lineIndex;
      let to = lineIndex;
      while (from > 0 && lineIndex - from < 6 && isLabelLine(lines[from - 1]!)) from--;
      while (to < lines.length - 1 && to - lineIndex < 6 && isLabelLine(lines[to + 1]!)) to++;
      scope = lines.slice(from, to + 1).join("\n").trim();
    }
    found.push({ sentence, scope });
  }
  return found.length ? found : null;
}

// Ordinary affirmative wording that contains a negation word.
const AFFIRMATIVE_NEGATIONS =
  /\bno[- ](?:obligation|charge|cost|fee|trip(?: charge| fee)?|hidden (?:fees?|costs?|charges?)|extra (?:charges?|costs?|fees?)|contracts?|commitment)\b|\bno (?:heat|heating|cooling|hot water|power|air|ac|a\/c|hvac)\b|\bnot (?:working|heating|cooling|turning on|running|starting)\b|\bnever (?:close|closes|closed)\b|\bnot-for-profit\b|\bnon-?profit\b/gi;
// A hedge, negation, or condition means the quote does not plainly assert the
// claim. The result is Unconfirmed, never Verified.
const HEDGED =
  /\b(?:no|not|never|without|coming soon|coming soonish|soon|planned|pending|if available|when available|temporarily|discontinued|formerly|used to|subject to|depending|varies|may|might|911|unavailable|cannot|suspended|ended|closed|except|excluding|excluded|limited|another company|third[- ]party|outsourced|voicemail)\b|n't\b/i;
export const quoteIsHedged = (quote: string) =>
  HEDGED.test(normalizeScraped(quote).replace(AFFIRMATIVE_NEGATIONS, " "));

// Instruction-like text inside website content. Website text is evidence only:
// a quote that tries to steer the assessment is never accepted as evidence.
const INSTRUCTION_LIKE = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:rubric|instructions?|rules?|prompt|schema|above|previous|prior)\b/i,
  /\b(?:assign|give|set|mark|rate|score|classify)\b[^.\n]{0,30}\b(?:grade|fit|score)\s*(?:of|to|is|=|:)?\s*["']?[ABC]\b/i,
  /\b(?:system|developer|assistant)\s*(?:prompt|message|instructions?)\b/i,
  /\byou are now\b/i,
  /\b(?:tool|function) calls?\b|\bcall (?:the|a) (?:tool|function|api)\b/i,
  /\b(?:run|execute)\b[^.\n]{0,20}\b(?:query|command|script|sql|code)\b/i,
  /\b(?:drop|delete|truncate)\s+(?:table|from)\b|\binsert\s+into\b|\bselect\s+\*\s+from\b|\bselect\s+[\w.]+(?:\s*,\s*[\w.]+)+\s+from\b/i,
  /\b(?:api[_ -]?key|password|secret|bearer|credentials)\b/i,
];
export const isInstructionLike = (value: string) =>
  INSTRUCTION_LIKE.some((pattern) => pattern.test(lintable(value)));
// Model-written free text never carries links, markup, or addresses.
const MARKUP_OR_LINK =
  /<[^>]+>|\[[^\]]*\]\([^)]*\)|```|https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.]+/i;
// Internal identifiers (observation, signal, unknown, and category ids are all
// snake_case) never belong in text a person reads.
export const containsInternalId = (value: string) =>
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/i.test(value);
// Model prose is withheld when it echoes instructions, carries links or markup,
// or leaks an internal identifier.
export const isSuspiciousText = (value: string) =>
  isInstructionLike(value) ||
  MARKUP_OR_LINK.test(lintable(value)) ||
  containsInternalId(value);

const ROUND_THE_CLOCK = /\b24\s*[\/-]\s*7\b|\b24[- ]hours?\b|\baround the clock\b|\bround[- ]the[- ]clock\b/i;
const PHONE_WORDS = /\b(?:calls?|phones?|telephone|answer(?:s|ed|ing)?|dispatch\w*|line)\b/i;

const URGENCY_OPTIONS = [
  /\burgent\b/i,
  /\bcall today\b/i,
  /\bsame[- ]day\b/i,
  /\bthis week\b/i,
  /\bnext week\b/i,
  /\bflexible\b/i,
  /\bplanning ahead\b/i,
];
// A phone number is a 10-digit number, or a 7-digit one that follows a word like "call". Numbers
// labelled as a fax, invoice, licence, permit, or reference are not the business's phone line.
const PHONE_GLOBAL = /(?<![\w-])(?:\(\d{3}\)\s?|\d{3}[-. ])?\d{3}[-. ]\d{4}\b/g;
const NOT_A_PHONE_LABEL = /\b(?:fax|invoice|licen[sc]e|permit|ref(?:erence)?|order|account|acct|id|serial|model|part|lic)\b[\s:#.-]{0,3}$/i;
const CALL_WORD_BEFORE = /\b(?:call|phone|tel(?:ephone)?|text|dial)\b[^.\n]{0,40}$/i;
export const findPhoneNumber = (raw: string): string | null => {
  // Typographic hyphens and dashes are ordinary separators in a phone number.
  const value = raw.replace(/[‐‑‒–—−]/g, "-");
  for (const match of value.matchAll(PHONE_GLOBAL)) {
    const before = value.slice(Math.max(0, match.index! - 60), match.index!);
    if (NOT_A_PHONE_LABEL.test(before)) continue;
    if (match[0].replace(/\D/g, "").length >= 10 || CALL_WORD_BEFORE.test(before)) return match[0];
  }
  return null;
};
// "Emergency" must be part of an offer of service. A question, a heading about what an emergency
// is, "emergency contact", and "non-emergency" are not.
export const EMERGENCY_SERVICE =
  /(?<![-\w])emergency\s+(?:(?!(?:contact|number|name|room|exit|plan|preparedness|situations?|is|are|the|what|counts?)\b)[a-z\/&]+\s+){0,4}(?:service|services|repairs?|calls?|dispatch|response|visits?|technicians?|help|appointments?|assistance)\b|\b(?:24\s*[\/-]\s*7|24[- ]hours?|round[- ]the[- ]clock|around the clock)\s+emergency\b|\bavailable\s+(?:for|in)\s+emergenc(?:ies|y)\b/i;
// Days plus a time range ("Mon-Fri 8am-5pm", "Monday through Friday, 8:00 AM to 5:00 PM"). A day and
// a single time ("Monday at 9am") is an appointment or an event, not opening hours.
const BUSINESS_HOURS =
  /\b(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b[^.\n]{0,40}?\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)\s*(?:-|–|—|to|until|till)\s*\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)/i;
const RESPONSE_WINDOW =
  /\bwithin\s+(?:\d+|one|two|three|four|five|ten|twenty|thirty)\s*(?:minutes?|mins?|hours?|business days?|days?)\b/i;

export type ObservationType = {
  id: string;
  category: AssessmentCategoryId;
  label: string;
  // Does the quote show exactly this claim?
  shows: (quote: string) => boolean;
  // Related wording is present, but this claim is not fully shown.
  partial?: (quote: string) => boolean;
  // The claim is about interface text itself (a form's options), so interface-label
  // quotes are the right evidence and are not treated as ambiguous.
  uiOption?: true;
  // Hedge words inside the evidence (an option such as "if available") do not hedge the claim.
  hedgeExempt?: true;
  // Only interface text can show this claim; prose that mentions the same words does not.
  requiresUi?: true;
  // A high-stakes claim: it must come from a statement (a sentence or heading), never a label.
  requiresStatement?: true;
  // Wording used when the value cannot be taken verbatim from the stored quote.
  plain?: () => string;
  // Server-written wording. Any value in it is extracted from the quote.
  statement: (quote: string) => string;
};

export const OBSERVATION_TYPES: readonly ObservationType[] = [
  {
    id: "phone_number_listed",
    category: "phone_intake",
    label: "Phone number listed",
    // A quote holding a telephone link that does not dial the number it shows is not evidence of either.
    shows: (q) => findPhoneNumber(q) !== null && !hasUnresolvedTel(q),
    statement: (q) => `The website lists the phone number ${findPhoneNumber(q)}.`,
    plain: () => "The website lists a phone number.",
  },
  {
    id: "business_hours_listed",
    category: "phone_intake",
    label: "Business hours listed",
    shows: (q) => BUSINESS_HOURS.test(q),
    statement: (q) => `The website lists business hours: "${BUSINESS_HOURS.exec(q)![0].trim()}".`,
    plain: () => "The website lists business hours.",
  },
  {
    id: "contact_form_offered",
    category: "website_forms",
    label: "Contact or request form offered",
    shows: (q) =>
      /\b(?:contact|request|inquiry|enquiry|service request|quote request)\s+form\b|\bfill out (?:our|the|a) (?:online )?form\b|\bsubmit (?:a |the |your )?(?:request|form)\b/i.test(q),
    statement: () => "The website offers a form for contacting the business or requesting service.",
  },
  {
    id: "quote_request_offered",
    category: "website_forms",
    label: "Quote or estimate request offered",
    shows: (q) =>
      /\brequest (?:a |an )?(?:free )?(?:quote|estimate)\b|\bget (?:a |an |your )?(?:free )?(?:quote|estimate)\b|\bfree (?:quotes?|estimates?)\b/i.test(q),
    statement: () => "The website invites visitors to request a quote or estimate.",
  },
  {
    id: "form_urgency_selector_offered",
    category: "website_forms",
    label: "Form urgency selector offered",
    // Options such as "Urgent / call today" show that a request form asks how soon
    // service is needed. They do not show that the business offers emergency service.
    shows: (q) => URGENCY_OPTIONS.filter((option) => option.test(q)).length >= 3,
    uiOption: true,
    hedgeExempt: true,
    requiresUi: true,
    statement: () => "The website's request form lets visitors say how soon they need service.",
  },
  {
    id: "online_booking_offered",
    category: "online_booking",
    label: "Online booking or scheduling offered",
    shows: (q) =>
      /\bonline (?:booking|scheduling|appointments?|schedule)\b|\b(?:book|schedule)(?: an? \w+)? online\b|\bbook now\b|\bschedule now\b/i.test(q),
    partial: (q) => /\b(?:book|schedul)\w*/i.test(q),
    statement: () => "The website offers online booking or scheduling.",
  },
  {
    id: "emergency_service_stated",
    requiresStatement: true,
    category: "after_hours",
    label: "Emergency service stated",
    shows: (q) => EMERGENCY_SERVICE.test(q),
    statement: () => "The website states that it offers emergency service.",
  },
  {
    id: "round_the_clock_phone_stated",
    requiresStatement: true,
    category: "after_hours",
    label: "Round-the-clock phone availability stated",
    // Emergency service or 24/7 alone does not say that calls are answered.
    shows: (q) => ROUND_THE_CLOCK.test(q) && PHONE_WORDS.test(q),
    partial: (q) => ROUND_THE_CLOCK.test(q),
    statement: () => "The website states that phone calls are answered around the clock.",
  },
  {
    id: "after_hours_availability_stated",
    requiresStatement: true,
    category: "after_hours",
    label: "After-hours or weekend availability stated",
    shows: (q) =>
      /\b(?:after[- ]hours|evenings?|weekends?|nights?|holidays?)\b[^.\n]*\b(?:available|open|service|appointments?|calls?)\b|\b(?:open|available|service)\b[^.\n]*\b(?:after[- ]hours|evenings?|weekends?|nights?|holidays?)\b/i.test(q),
    statement: () => "The website states after-hours, evening, or weekend availability.",
  },
  {
    id: "callback_offered",
    category: "follow_up",
    label: "Callback or contact-back stated",
    shows: (q) =>
      /\bcall(?:s)? you back\b|\bcall-?back\b|\bwe(?:'ll| will) (?:call|contact|get back to|reach out to) you\b/i.test(q),
    statement: () => "The website says the business will call or contact the customer back.",
  },
  {
    id: "response_commitment_stated",
    category: "follow_up",
    label: "Response commitment stated",
    shows: (q) => RESPONSE_WINDOW.test(q),
    statement: (q) =>
      `The website states a response commitment of "${RESPONSE_WINDOW.exec(q)![0].trim()}" (the business's own statement, not measured performance).`,
    plain: () => "The website states a response commitment (the business's own statement, not measured performance).",
  },
  {
    id: "customer_portal_offered",
    category: "crm_integrations",
    label: "Customer portal referenced",
    shows: (q) => /\b(?:customer|client) portal\b|\bonline portal\b/i.test(q),
    statement: () => "The website refers to a customer portal.",
  },
  {
    id: "online_payment_offered",
    category: "crm_integrations",
    label: "Online payment offered",
    shows: (q) => /\bpay (?:your (?:bill|invoice) )?online\b|\bonline payments?\b/i.test(q),
    statement: () => "The website offers online payment.",
  },
];
export const OBSERVATION_TYPE_IDS = OBSERVATION_TYPES.map((type) => type.id) as [
  string,
  ...string[],
];
export const observationType = (id: string): ObservationType | undefined =>
  OBSERVATION_TYPES.find((type) => type.id === id);

// Where each quote occurs in its stored source (see enclosingText). A plain string stands for
// an occurrence whose sentence and scope are both that text. A null entry means the quote could
// not be found in its source, so nothing about it can be called supported.
export type QuoteContexts = readonly (readonly (string | Occurrence)[] | null)[];
export type JudgeFlags = {
  allowUi?: boolean | undefined;
  requiresUi?: boolean | undefined;
  requiresStatement?: boolean | undefined;
  hedgeExempt?: boolean | undefined;
};

// Judges one quote that shows a claim, against everywhere it occurs in its source. A hedge anywhere
// near any occurrence makes the claim ambiguous. Unless the claim is about interface text, at least
// one occurrence must be free of interface labels (and, for a high-stakes claim, be a statement).
export function judgeQuote(
  quote: string,
  occurrences: readonly (string | Occurrence)[] | null | undefined,
  flags: JudgeFlags,
): Support {
  if (occurrences === null) return "ambiguous";
  const found = (occurrences ?? [quote]).map((item) => (typeof item === "string" ? { sentence: item, scope: item } : item));
  if (flags.requiresUi) return found.some((item) => isUiFragment(item.scope)) ? "supported" : "unsupported";
  const clean = found.filter(
    (item) => (flags.allowUi || !isUiFragment(item.scope)) && (!flags.requiresStatement || isStatement(item.sentence)),
  );
  if (!clean.length) return "ambiguous";
  const hedged = !flags.hedgeExempt && (quoteIsHedged(quote) || found.some((item) => quoteIsHedged(item.scope)));
  return hedged ? "ambiguous" : "supported";
}

// How well the cited quotes support one observation type. One quote must show the claim, so
// unrelated quotes never combine. Interpretation uses normalized text.
export function observationSupport(
  type: ObservationType,
  quotes: readonly string[],
  contexts?: QuoteContexts,
): Support {
  const normalized = quotes.map(normalizeScraped);
  const showing = normalized.flatMap((quote, index) => (type.shows(quote) ? [index] : []));
  if (!showing.length)
    return normalized.some((quote) => type.partial?.(quote)) ? "ambiguous" : "unsupported";
  const verdicts = showing.map((index) =>
    judgeQuote(quotes[index]!, contexts ? contexts[index] : undefined, {
      allowUi: type.uiOption,
      requiresUi: type.requiresUi,
      requiresStatement: type.requiresStatement,
      hedgeExempt: type.hedgeExempt,
    }),
  );
  // Any one quote that stands on its own is enough; a weaker quote beside it changes nothing.
  return verdicts.includes("supported") ? "supported" : verdicts.includes("ambiguous") ? "ambiguous" : "unsupported";
}

// The wording comes from the first quote that shows the claim on its own. A value is taken from
// the stored quote verbatim; if only the normalized copy matches, the wording carries no value.
export function observationStatement(type: ObservationType, quotes: readonly string[]): string {
  const raw = quotes.find((quote) => type.shows(quote));
  if (raw) return type.statement(raw);
  const normalized = quotes.map(normalizeScraped).find((quote) => type.shows(quote));
  return normalized && type.plain ? type.plain() : type.statement(normalized ?? normalizeScraped(quotes.join("\n")));
}

// Operational unknowns, from the original UNKNOWN STANDARD. The model selects
// ids; the server writes the text, so an unknown can never smuggle in a claim.
export const UNKNOWN_TOPICS = [
  { id: "first_to_see_request", text: "Who sees a request first", phrase: "who sees a request first" },
  { id: "request_assignment", text: "How requests are assigned", phrase: "how requests are assigned" },
  { id: "forms_calls_same_system", text: "Whether forms and calls enter the same system", phrase: "whether forms and calls enter the same system" },
  { id: "urgent_identification", text: "How urgent inquiries are identified", phrase: "how urgent inquiries are identified" },
  { id: "after_hours_handling", text: "What happens after hours", phrase: "what happens after hours" },
  { id: "failed_callback_tracking", text: "How failed callbacks are tracked", phrase: "how failed callbacks are tracked" },
  { id: "followup_ownership", text: "Who owns follow-up", phrase: "who owns follow-up" },
  { id: "open_estimate_tracking", text: "How open estimates are tracked", phrase: "how open estimates are tracked" },
  { id: "location_intake_sharing", text: "Whether multiple locations share one intake process", phrase: "whether multiple locations share one intake process" },
  { id: "response_time", text: "Response time", phrase: "what the response time is" },
  { id: "lead_volume", text: "Lead volume", phrase: "what the lead volume is" },
  { id: "booking_rate", text: "Booking rate", phrase: "what the booking rate is" },
  { id: "crm_usage", text: "CRM usage", phrase: "whether and how a CRM is used" },
  { id: "economic_value", text: "Economic value", phrase: "what the economic value is" },
] as const;
export type UnknownId = (typeof UNKNOWN_TOPICS)[number]["id"];
export const UNKNOWN_IDS = UNKNOWN_TOPICS.map((topic) => topic.id) as [
  UnknownId,
  ...UnknownId[],
];
export const unknownTopic = (id: UnknownId): string =>
  UNKNOWN_TOPICS.find((item) => item.id === id)!.text;
const unknownPhrase = (id: UnknownId): string =>
  UNKNOWN_TOPICS.find((item) => item.id === id)!.phrase;
// The original HYPOTHESIS STANDARD as a template: observed public evidence plus an
// operational unknown is a discovery opportunity. The server writes the sentence, so
// it cannot carry a claim, an identifier, or text from a website.
export const composeHypothesis = (observed: string, unknown: UnknownId): string =>
  `${observed.replace(/\.$/, "")}, so it may be worth understanding ${unknownPhrase(unknown)}.`;
export const unknownText = (id: UnknownId): string => {
  const topic = UNKNOWN_TOPICS.find((item) => item.id === id)!;
  return `${topic.text} is not shown in the retrieved website excerpts.`;
};
