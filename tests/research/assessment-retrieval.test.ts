import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ASSESSMENT_CATEGORIES,
  ASSESSMENT_RETRIEVAL_LIMITS,
  mergeAssessmentEvidence,
  type AssessmentRetrievalLimits,
  type EvidenceCandidate,
} from "../../src/research/lead-intake-assessment.js";

const chunk = (id: string, url: string, content: string): EvidenceCandidate => ({
  id,
  sourceUrl: `https://example.com/${url}`,
  content,
});
const limits = (overrides: Partial<AssessmentRetrievalLimits> = {}): AssessmentRetrievalLimits => ({
  ...ASSESSMENT_RETRIEVAL_LIMITS,
  ...overrides,
});
const ids = (merged: { candidate: EvidenceCandidate }[]) => merged.map((item) => item.candidate.id);

test("keyword matches are taken first, the vector fills the rest, and the per-category budget holds", () => {
  const vector = ["v1", "v2", "v3", "v4", "v5", "v6", "v7"].map((id, i) => chunk(id, `p${i}`, `vector text ${id}`));
  const keyword = ["k1", "k2", "k3"].map((id, i) => chunk(id, `k${i}`, `keyword text ${id}`));
  const merged = mergeAssessmentEvidence([{ vector, keyword }], limits());
  // 2 keyword slots by default, then vector up to perCategory (5) in total.
  assert.deepEqual(ids(merged), ["k1", "k2", "v1", "v2", "v3"]);
  assert.deepEqual(merged.map((item) => item.via), ["keyword", "keyword", "vector", "vector", "vector"]);
  // keywordSlots overrides the default for a category.
  assert.deepEqual(ids(mergeAssessmentEvidence([{ vector, keyword, keywordSlots: 3 }], limits())), ["k1", "k2", "k3", "v1", "v2"]);
  // Zero keyword slots is the vector-only behavior.
  assert.deepEqual(ids(mergeAssessmentEvidence([{ vector, keyword, keywordSlots: 0 }], limits({ keywordPerCategory: 0 }))), ["v1", "v2", "v3", "v4", "v5"]);
});

test("a chunk found by both searches is labeled both, and a chunk already chosen by another category still counts toward it", () => {
  const shared = chunk("shared", "a", "found by both searches");
  const other = chunk("other", "b", "only the vector found this");
  const merged = mergeAssessmentEvidence(
    [
      { vector: [shared, other], keyword: [shared] },
      { vector: [shared, chunk("x1", "c", "x one"), chunk("x2", "d", "x two"), chunk("x3", "e", "x three"), chunk("x4", "f", "x four"), chunk("x5", "g", "x five")], keyword: [] },
    ],
    limits(),
  );
  assert.equal(merged.filter((item) => item.candidate.id === "shared").length, 1);
  assert.equal(merged.find((item) => item.candidate.id === "shared")!.via, "both");
  // The second category counted `shared` as one of its five, so it added only four more.
  assert.deepEqual(ids(merged), ["shared", "other", "x1", "x2", "x3", "x4"]);
});

test("exact duplicates and chunks contained in an earlier choice are dropped, so a site-wide widget cannot fill the budget", () => {
  const widget = "### How soon do you need service?\n\nUrgent / call todaySame-day if availableThis weekFlexible / planning ahead";
  const vector = [
    chunk("w1", "home", widget),
    chunk("w2", "contact", widget),
    chunk("w3", "about", `  ${widget.toUpperCase()}\n`),
    chunk("inside", "x", "Same-day if availableThis weekFlexible"),
    ...["d1", "d2", "d3", "d4"].map((id, i) => chunk(id, `d${i}`, `distinct text ${id}`)),
  ];
  const merged = mergeAssessmentEvidence([{ vector, keyword: [] }], limits());
  assert.deepEqual(ids(merged), ["w1", "d1", "d2", "d3", "d4"]);
  // A near-copy that only adds a little to an earlier choice is dropped too ...
  const nearCopy = mergeAssessmentEvidence([{ vector: [chunk("a", "a", "emergency repair team on duty today"), chunk("b", "b", "Emergency repair team on duty today!")], keyword: [] }], limits());
  assert.deepEqual(ids(nearCopy), ["a"]);
  // ... but a larger chunk that merely contains a short earlier one (a page title) is new information and is kept.
  const grown = mergeAssessmentEvidence([{ vector: [chunk("title", "a", "Emergency HVAC Repair • Linden, NJ"), chunk("body", "b", "Emergency HVAC Repair • Linden, NJ. When a heating or cooling system stops working at the worst time, you need a clear plan and a technician who explains each step.")], keyword: [] }], limits());
  assert.deepEqual(ids(grown), ["title", "body"]);
});

test("keyword evidence comes best-first from distinct pages, with at most two chunks per page", () => {
  const keyword = [
    chunk("e1", "emergency", "emergency page chunk one"),
    chunk("e2", "emergency", "emergency page chunk two"),
    chunk("e3", "emergency", "emergency page chunk three"),
    chunk("h1", "home", "home page emergency call to action"),
    chunk("c1", "contact", "contact page mention"),
  ];
  const merged = mergeAssessmentEvidence([{ vector: [], keyword, keywordSlots: 4 }], limits());
  assert.deepEqual(ids(merged), ["e1", "e2", "h1", "c1"]);
  assert.equal(merged.filter((item) => item.candidate.sourceUrl.endsWith("/emergency")).length, 2);
  assert.deepEqual(ids(mergeAssessmentEvidence([{ vector: [], keyword, keywordSlots: 4 }], limits({ maxKeywordPerPage: 1 }))), ["e1", "h1", "c1"]);
});

test("the chunk and byte budgets are hard limits, whatever the categories ask for", () => {
  const many = (prefix: string, count: number, size = 500) =>
    Array.from({ length: count }, (_, i) => chunk(`${prefix}${i}`, `${prefix}${i}`, `${prefix} ${i} `.padEnd(size, "x")));
  const categories = ASSESSMENT_CATEGORIES.map((category, index) => ({
    vector: many(`${category.id}-v`, 12),
    keyword: many(`${category.id}-k`, 6),
    keywordSlots: index === 3 ? 3 : 2,
  }));
  const capped = mergeAssessmentEvidence(categories, limits({ maxChunks: 11 }));
  assert.equal(capped.length, 11);
  const bytes = (merged: { candidate: EvidenceCandidate }[]) => merged.reduce((total, item) => total + Buffer.byteLength(item.candidate.content), 0);
  const tight = mergeAssessmentEvidence(categories, limits({ maxBytes: 2_600 }));
  assert.ok(bytes(tight) <= 2_600 && tight.length === 5, `${tight.length} chunks, ${bytes(tight)} bytes`);
  // The defaults hold the assessment to the same ceiling as before: 6 categories x 5.
  const normal = mergeAssessmentEvidence(categories, limits());
  assert.ok(normal.length <= ASSESSMENT_RETRIEVAL_LIMITS.maxChunks);
  assert.ok(bytes(normal) <= ASSESSMENT_RETRIEVAL_LIMITS.maxBytes);
  assert.equal(normal.length, 30);
  assert.equal(ASSESSMENT_RETRIEVAL_LIMITS.perCategory * ASSESSMENT_CATEGORIES.length, 30);
});

test("every category has bounded, fixed keyword terms, with extra slots only where the exact words carry the signal", () => {
  for (const category of ASSESSMENT_CATEGORIES) {
    assert.ok(category.keywords.length > 10 && category.keywords.length < 200, category.id);
    assert.doesNotMatch(category.keywords, /[;()\\]/, category.id);
  }
  assert.deepEqual(
    ASSESSMENT_CATEGORIES.filter((category) => category.keywordSlots !== undefined).map((category) => [category.id, category.keywordSlots]),
    [["after_hours", 3]],
  );
  assert.match(ASSESSMENT_CATEGORIES.find((category) => category.id === "after_hours")!.keywords, /emergency/);
});

test("categories share a tight budget fairly: multibyte text cannot let the first categories take it all", () => {
  // 1,200 three-byte characters is 3,600 bytes, so a 36,000-byte budget holds only ten of these.
  const big = (id: string, url: string) => chunk(id, url, `${id} `.padEnd(1_200, "語"));
  const categories = ASSESSMENT_CATEGORIES.map((category) => ({
    vector: Array.from({ length: 10 }, (_, i) => big(`${category.id}-v${i}`, `${category.id}${i}`)),
    keyword: [],
  }));
  const merged = mergeAssessmentEvidence(categories, limits());
  const bytes = merged.reduce((total, item) => total + Buffer.byteLength(item.candidate.content), 0);
  assert.ok(bytes <= ASSESSMENT_RETRIEVAL_LIMITS.maxBytes);
  const perCategory = ASSESSMENT_CATEGORIES.map((category) => merged.filter((item) => item.candidate.id.startsWith(`${category.id}-`)).length);
  assert.ok(perCategory.every((count) => count >= 1), `chunks per category: ${perCategory.join(", ")}`);
  assert.ok(Math.max(...perCategory) - Math.min(...perCategory) <= 1, `chunks per category: ${perCategory.join(", ")}`);
  // Keyword picks are shared fairly too.
  const withKeywords = ASSESSMENT_CATEGORIES.map((category) => ({
    vector: [],
    keyword: Array.from({ length: 6 }, (_, i) => big(`${category.id}-k${i}`, `${category.id}k${i}`)),
  }));
  const keywordMerge = mergeAssessmentEvidence(withKeywords, limits());
  const keywordCounts = ASSESSMENT_CATEGORIES.map((category) => keywordMerge.filter((item) => item.candidate.id.startsWith(`${category.id}-`)).length);
  assert.ok(keywordCounts.every((count) => count >= 1), keywordCounts.join(", "));
});

test("a chunk found by both searches uses one slot in its category, not two", () => {
  const both = chunk("both", "a", "found by both searches");
  const merged = mergeAssessmentEvidence(
    [{ vector: [both, ...["v1", "v2", "v3", "v4", "v5"].map((id) => chunk(id, id, `vector ${id}`))], keyword: [both] }],
    limits(),
  );
  assert.deepEqual(ids(merged), ["both", "v1", "v2", "v3", "v4"]);
  assert.equal(merged[0]!.via, "both");
  // via reflects the searches that found the chunk for the categories that picked it.
  assert.deepEqual(merged.slice(1).map((item) => item.via), ["vector", "vector", "vector", "vector"]);
});
