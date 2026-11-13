import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildAssessmentResult, parseAssessmentDraft, type RetrievedSource } from "../../src/research/lead-intake-assessment.js";
import { REPLAY_RAW_DRAFT, REPLAY_SOURCES } from "../helpers/sadowski-replay-fixture.js";

const PHONE_LINK = "[732-551-7848](tel:+17325517848)";
const PHONE_QUOTE = "Call 732-551-7848";
const INTAKE_QUOTE = `Call ${PHONE_LINK} or use the request form with your property address and a short description.`;

const retrieved = (overrides: Record<string, string> = {}): RetrievedSource[] =>
  REPLAY_SOURCES.map((item) => ({
    ...item,
    text: overrides[item.id] ?? item.text,
    chunkId: `chunk-${item.id}`,
    via: "vector" as const,
  }));
const ids = REPLAY_SOURCES.map((item) => item.id);
const draftWith = (change: (draft: Record<string, any>) => void) => {
  const draft = JSON.parse(JSON.stringify(REPLAY_RAW_DRAFT)) as Record<string, any>;
  change(draft);
  return draft;
};
const build = (draft: unknown, sources = retrieved()) => buildAssessmentResult(parseAssessmentDraft(draft, ids), sources);
const phoneIntake = (draft: Record<string, any>) => draft.categories.find((item: any) => item.category === "phone_intake");
const observationTypes = (result: ReturnType<typeof build>["result"]) =>
  result.categories.flatMap((item) => item.observations.map((observation) => `${item.category}:${observation.type}`));

test("the saved live model output is replayed with the phone number and the follow-up question accepted", () => {
  assert.match(REPLAY_SOURCES.find((item) => item.id === "S7")!.text, /\[732-551-7848\]\(tel:\+17325517848\)/);
  const { result, withheld } = build(REPLAY_RAW_DRAFT);

  assert.deepEqual(observationTypes(result), [
    "phone_intake:phone_number_listed",
    "phone_intake:business_hours_listed",
    "website_forms:contact_form_offered",
    "website_forms:form_urgency_selector_offered",
    "after_hours:emergency_service_stated",
    "follow_up:callback_offered",
  ]);
  const phone = result.categories.find((item) => item.category === "phone_intake")!.observations[0]!;
  assert.equal(phone.statement, "The website lists the phone number 732-551-7848.");
  // The citation is the model's quote, as written, with the stored chunk and page it came from.
  assert.deepEqual(phone.citations, [
    { sourceId: "S7", sourceUrl: "https://www.sadowski-hvac.com/", chunkId: "chunk-S7", quote: PHONE_QUOTE },
  ]);
  assert.deepEqual(
    result.categories.find((item) => item.category === "follow_up")!.discoveryQuestions,
    ["After you contact someone about their request, who owns any further follow-up?"],
  );
  // Only the unsupported "broad service territory" signal remains withheld.
  assert.equal(withheld, 1);
  assert.equal(result.withheld, 1);
  assert.deepEqual(result.unconfirmed, []);
});

test("the grade stays A on the same signals, and the phone number does not change it", () => {
  const { result } = build(REPLAY_RAW_DRAFT);
  assert.equal(result.fit.grade, "A");
  assert.equal(result.fit.basis, "strong_complexity");
  assert.deepEqual(result.fit.signals.map((item) => item.id), [
    "urgent_or_emergency_service",
    "multiple_intake_paths",
    "multiple_service_categories",
  ]);
  // The intake-paths signal keeps its stored quote exactly as the model wrote it, Markdown included.
  assert.equal(result.fit.signals[1]!.citations[0]!.quote, INTAKE_QUOTE);
  assert.ok(!result.fit.signals.some((item) => item.id === "broad_service_territory"));

  const withoutPhone = build(
    draftWith((draft) => {
      phoneIntake(draft).observations = phoneIntake(draft).observations.filter((item: any) => item.type !== "phone_number_listed");
      phoneIntake(draft).hypotheses = [];
    }),
  ).result;
  assert.equal(withoutPhone.fit.grade, "A");
  assert.deepEqual(withoutPhone.fit.signals.map((item) => item.id), result.fit.signals.map((item) => item.id));
});

test("replaying adds the phone evidence and its hypothesis, and nothing else", () => {
  const { result } = build(REPLAY_RAW_DRAFT);
  const accepted = new Map(
    result.categories.flatMap((item) => item.observations.map((observation) => [observation.type, observation.statement] as const)),
  );
  // Every hypothesis is the server's sentence about an observation it accepted.
  for (const category of result.categories)
    for (const hypothesis of category.hypotheses) {
      const observed = [...accepted.values()].find((statement) => hypothesis.startsWith(statement.replace(/\.$/, "")));
      assert.ok(observed, hypothesis);
    }
  assert.deepEqual(result.categories.find((item) => item.category === "phone_intake")!.hypotheses, [
    "The website lists the phone number 732-551-7848, so it may be worth understanding who sees a request first.",
  ]);
  assert.equal(result.categories.flatMap((item) => item.hypotheses).length, 5);
  assert.equal(result.primaryOpportunityHypothesis?.category, "after_hours");
  assert.equal(result.primaryDiscoveryQuestion, "How do you handle an emergency HVAC request that comes in outside office hours?");
  assert.deepEqual(result.topOpportunities.map((item) => item.title), [
    "What happens after hours",
    "How urgent inquiries are identified",
    "Who sees a request first",
  ]);
});

test("the quoted number must be the one the telephone link dials", () => {
  const accepts = (sourceText: string, quote: string) => {
    const sources = retrieved({ S7: sourceText });
    const { result } = build(draftWith((draft) => { phoneIntake(draft).observations[0].citations[0].quote = quote; }), sources);
    return observationTypes(result).includes("phone_intake:phone_number_listed");
  };
  const original = REPLAY_SOURCES.find((item) => item.id === "S7")!.text;
  const relink = (link: string) => original.replace(PHONE_LINK, link);

  assert.equal(accepts(original, PHONE_QUOTE), true);
  // The same quote as the stored Markdown also stands.
  assert.equal(accepts(original, `Call ${PHONE_LINK}`), true);
  assert.equal(accepts(original, PHONE_LINK), true);

  // Extra words in the link label are fine when the link dials the quoted number.
  assert.equal(accepts(relink("[Call 732-551-7848](tel:+17325517848)"), PHONE_QUOTE), true);

  // The link dials a different number than it shows.
  assert.equal(accepts(relink("[732-551-7848](tel:+19998887777)"), PHONE_QUOTE), false);
  assert.equal(accepts(relink("[732-551-7848](tel:+19998887777)"), "Call [732-551-7848](tel:+19998887777)"), false);
  // A label that carries the number but whose link dials another one.
  assert.equal(accepts(relink("[Call us 732-551-7848](tel:+19998887777)"), "Call us 732-551-7848"), false);
  // "+7" is another country's number, not the one shown.
  assert.equal(accepts(relink("[732-551-7848](tel:+7325517848)"), PHONE_QUOTE), false);
  // Full-width characters, and a number hidden in a parameter, cannot disguise a link to another number.
  assert.equal(accepts(relink("[Call us \uff17\uff13\uff12-551-7848](tel:+19998887777)"), "us 732-551-7848"), false);
  assert.equal(accepts(relink("[732-551-7848](\uff54\uff45\uff4c:+19998887777)"), "732-551-7848"), false);
  assert.equal(accepts(relink("[Call us 732-551-7848](tel:+17000000000;ext=7325517848)"), "us 732-551-7848"), false);
  // Destinations that are not plain numbers are not interpreted.
  assert.equal(accepts(relink("[732-551-7848](tel:+17325517848;ext=1)"), PHONE_QUOTE), false);
  assert.equal(accepts(relink("[732-551-7848](tel:%2B17325517848)"), PHONE_QUOTE), false);
  assert.equal(accepts(relink("[732-551-7848](javascript:alert(1))"), PHONE_QUOTE), false);
  assert.equal(accepts(relink("[732-551-7848](sms:+17325517848)"), PHONE_QUOTE), false);
  // A model cannot invent, alter, or complete the number or the link.
  assert.equal(accepts(original, "Call 732-551-7849"), false);
  assert.equal(accepts(original, "Call 732-551-784"), false);
  assert.equal(accepts(original, "Call 732-551-7848](tel:+19998887777)"), false);
  assert.equal(accepts(original, "Call [732-551-7848](tel:+19998887777)"), false);
  assert.equal(accepts(original, "Call 7325517848"), false);
});

test("a rejected phone quote is withheld and counted, never shown as verified", () => {
  const sources = retrieved({ S7: REPLAY_SOURCES.find((item) => item.id === "S7")!.text.replace(PHONE_LINK, "[732-551-7848](tel:+19998887777)") });
  const { result, withheld } = build(REPLAY_RAW_DRAFT, sources);
  assert.ok(!observationTypes(result).includes("phone_intake:phone_number_listed"));
  assert.ok(withheld > 1);
  assert.deepEqual(result.categories.find((item) => item.category === "phone_intake")!.hypotheses, []);
  assert.equal(result.fit.grade, "A");
});
