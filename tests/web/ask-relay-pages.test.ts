import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { IndexedProspect } from "../../src/data/research-embeddings.js";
import type { AskRelayResult } from "../../src/research/ask-relay.js";
import {
  ASK_PAGE_CSP,
  renderAskAnswer,
  renderAskErrorPage,
  renderAskFailed,
  renderAskForm,
  renderAskPending,
} from "../../src/web/ask-relay-pages.js";

const XSS = `<script>alert("x")</script><img src=x onerror=alert(1)>`;
const prospects: IndexedProspect[] = [
  {
    id: "00000000-0000-4000-a000-000000000001",
    companyName: "Riverbend Comfort",
    website: "https://riverbend.example.com/",
    embeddedChunks: 3,
  },
  {
    id: "00000000-0000-4000-a000-000000000002",
    companyName: `Oak ${XSS}`,
    website: "https://oakhollow.example.com/",
    embeddedChunks: 2,
  },
];
const summary = { prospect: prospects[0]!, question: `Towns? ${XSS}` };
const next = { askId: "next-id", prospects, selected: prospects[0]!.id };
const answered: AskRelayResult = {
  question: summary.question,
  status: "answered",
  reason: null,
  answer: `Riverbend and Oak Hollow. ${XSS}`,
  citations: [
    { sourceId: "S1", sourceUrl: "https://riverbend.example.com/", quote: "Riverbend" },
    { sourceId: "S2", sourceUrl: "https://riverbend.example.com/areas", quote: `Oak ${XSS}` },
    { sourceId: "S2", sourceUrl: "https://riverbend.example.com/areas", quote: "Pine Flats" },
    { sourceId: "S3", sourceUrl: "javascript:alert(1)", quote: "Not a link" },
  ],
  retrieved: [
    { sourceId: "S1", sourceUrl: "https://riverbend.example.com/", similarity: 0.4567 },
    { sourceId: "S2", sourceUrl: "https://riverbend.example.com/areas", similarity: 0.3 },
  ],
};
const insufficient = (reason: Exclude<AskRelayResult["reason"], null>): AskRelayResult => ({
  question: summary.question,
  status: "insufficient_evidence",
  reason,
  answer: `The excerpts do not say. ${XSS}`,
  citations: [],
  retrieved: reason === "no_indexed_research" ? [] : answered.retrieved,
});

const allPages = () => [
  renderAskForm({ askId: "id", prospects }),
  renderAskForm({ askId: "id", prospects: [] }),
  renderAskForm({ askId: "id", prospects, question: XSS, error: XSS }),
  renderAskPending(summary, "id"),
  renderAskAnswer(summary, answered, next),
  renderAskAnswer(summary, insufficient("model_reported"), next),
  renderAskAnswer(summary, insufficient("unverified_citations"), next),
  renderAskAnswer(summary, insufficient("no_indexed_research"), next),
  renderAskFailed(summary, next),
  renderAskErrorPage(XSS, XSS),
];

test("Ask pages allow exactly their inline stylesheet and contain no scripts or handlers", () => {
  assert.ok(!ASK_PAGE_CSP.includes("unsafe"));
  assert.ok(!ASK_PAGE_CSP.includes("script-src"));
  assert.match(ASK_PAGE_CSP, /default-src 'none'/);
  for (const html of allPages()) {
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
    assert.ok(style !== undefined);
    const hash = createHash("sha256").update(style).digest("base64");
    assert.ok(ASK_PAGE_CSP.includes(`style-src 'sha256-${hash}'`));
    // Content escapes every "<", so a literal "<" always opens a real tag.
    assert.doesNotMatch(html, /<script|<img|<[^>]*\son\w+\s*=/i);
  }
});

test("Every dynamic value is escaped", () => {
  const escaped = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;";
  for (const html of allPages().slice(2)) assert.ok(html.includes(escaped));
  const form = renderAskForm({ askId: `"><b>`, prospects });
  assert.ok(form.includes('value="&quot;&gt;&lt;b&gt;"'));
  assert.ok(form.includes("Oak &lt;script&gt;"));
});

test("A verified answer shows grouped sources with https links and their quotes", () => {
  const html = renderAskAnswer(summary, answered, next);
  assert.match(html, /<details class="panel" open>\s*<summary>Latest answer<\/summary>/);
  assert.match(html, /Sources and verified quotes/);
  assert.ok(
    html.includes(
      '<a href="https://riverbend.example.com/areas" target="_blank" rel="noreferrer">https://riverbend.example.com/areas</a>',
    ),
  );
  // S2 is listed once with both of its quotes.
  assert.equal(html.match(/\[S2\]<\/span> <a/g)?.length, 1);
  assert.match(html, /<blockquote>Oak &lt;script&gt;[\s\S]*<blockquote>Pine Flats<\/blockquote>/);
  // A non-https stored URL is shown as text, never as a link.
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes("javascript:alert(1)"));
  assert.match(html, /Retrieved vector chunks: 2/);
  assert.match(html, /0\.457 · https:\/\/riverbend\.example\.com\//);
  assert.match(html, /Ask another question/);
});

test("Insufficient evidence is stated clearly, with no sources, for each reason", () => {
  const notes = {
    model_reported: /Relay did not guess or use outside knowledge/,
    unverified_citations: /quotes did not match the retrieved research/,
    no_indexed_research: /no embedded research to search/,
  } as const;
  for (const [reason, note] of Object.entries(notes)) {
    const html = renderAskAnswer(
      summary,
      insufficient(reason as keyof typeof notes),
      next,
    );
    assert.match(html, /<h2>Not enough evidence<\/h2>/);
    assert.match(html, note);
    assert.doesNotMatch(html, /Sources and verified quotes|<blockquote>/);
  }
  assert.doesNotMatch(
    renderAskAnswer(summary, insufficient("no_indexed_research"), next),
    /Retrieved vector chunks/,
  );
});

test("A pending answer refreshes itself and announces progress", () => {
  const html = renderAskPending(summary, "11111111-1111-4111-8111-111111111111");
  assert.match(html, /<meta http-equiv="refresh" content="1">/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /href="\/answer\?id=11111111-1111-4111-8111-111111111111"/);
  assert.doesNotMatch(html, /<form/);
});

test("A failed answer shows fixed text and offers to ask again", () => {
  const html = renderAskFailed(summary, next);
  assert.match(html, /Relay could not answer this question/);
  assert.match(html, /Ask again/);
});

test("The form keeps the selection and question, labels its fields, and handles no prospects", () => {
  const html = renderAskForm({
    askId: "id",
    prospects,
    selected: prospects[1]!.id,
    question: "\nStarts with a newline",
  });
  assert.match(html, /<option value="00000000-0000-4000-a000-000000000002" selected>/);
  assert.doesNotMatch(html, /000000000001" selected/);
  assert.match(html, /<label for="field-prospect">[\s\S]*id="field-prospect"/);
  assert.match(html, /<label for="field-question">[\s\S]*id="field-question"/);
  assert.match(html, /maxlength="500" required/);
  // HTML parsing drops the first newline after <textarea>, keeping the value.
  assert.match(html, /aria-describedby="question-hint">\n\nStarts with a newline<\/textarea>/);
  assert.match(html, /name="confirm" value="ask-relay">Ask Relay<\/button>/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);

  const empty = renderAskForm({ askId: "id", prospects: [] });
  assert.match(empty, /No prospect has embedded research yet/);
  assert.doesNotMatch(empty, /<form/);
});
