import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { AssessmentHistory, AssessmentRecord } from "../../src/data/lead-assessments.js";
import type { DashboardProspect } from "../../src/data/research-embeddings.js";
import {
  buildAssessmentResult,
  parseAssessmentDraft,
  type RetrievedSource,
} from "../../src/research/lead-intake-assessment.js";
import { ASSESSMENT_CONFIRM_VALUE, ASSESSMENT_PATH } from "../../src/web/assessment-pages.js";
import { createAskRelayHandler } from "../../src/web/ask-relay-server.js";
import { startIntakeServer, type IntakeServerEvent } from "../../src/web/intake-server.js";
import { DASHBOARD_CSP, renderDashboard } from "../../src/web/prospect-dashboard.js";
import { EMERGENCY_QUOTE, FORM_QUOTE, ONLY_PHONE_QUOTE, PHONE_QUOTE, sampleDraft } from "../helpers/assessment-fixtures.js";

const INDEXED = "00000000-0000-4000-a000-000000000001";
const BARE = "00000000-0000-4000-a000-000000000002";
const prospects: DashboardProspect[] = [
  { id: INDEXED, companyName: "Riverbend Comfort", website: "https://riverbend.example.com/", industry: null, contactName: null, contactEmail: null, stage: "researching", embeddedChunks: 3, websiteIndexStatus: "ready" },
  { id: BARE, companyName: "Bare Co", website: null, industry: null, contactName: null, contactEmail: null, stage: "researching", embeddedChunks: 0 },
];
const sources: RetrievedSource[] = [
  { id: "S1", chunkId: "c1", sourceUrl: "https://riverbend.example.com/contact", via: "vector" as const, text: `${PHONE_QUOTE} ${ONLY_PHONE_QUOTE} ${FORM_QUOTE}` },
  { id: "S2", chunkId: "c2", sourceUrl: "http://insecure.example.com/", via: "vector" as const, text: EMERGENCY_QUOTE },
];
const built = buildAssessmentResult(parseAssessmentDraft(sampleDraft(sources), ["S1", "S2"]), sources);

const FINGERPRINT = "f".repeat(64);
const record = (overrides: Partial<AssessmentRecord> = {}): AssessmentRecord => ({
  id: "r1", status: "completed", researchRequestId: "q1", evidenceFingerprint: FINGERPRINT,
  model: "m", result: built.result, withheldCount: 0, lastError: null,
  createdAt: new Date("2026-11-13T18:30:00Z"), updatedAt: new Date("2026-11-13T18:31:00Z"),
  outdated: false, ...overrides,
});
const history = (...records: AssessmentRecord[]): AssessmentHistory => ({
  current: { researchRequestId: "q1", fingerprint: FINGERPRINT, indexStatus: "ready", chunks: 3, embeddedChunks: 3 },
  records,
});
const page = (selected: DashboardProspect, assessment: AssessmentHistory | null) =>
  renderDashboard(prospects, selected, "11111111-1111-4111-8111-111111111111", null, null, assessment);
const [indexed, bare] = prospects as [DashboardProspect, DashboardProspect];

test("the server's route literals match the page's form constants", () => {
  assert.equal(ASSESSMENT_PATH, "/assessment");
  assert.equal(ASSESSMENT_CONFIRM_VALUE, "generate-assessment");
});

test("the section is collapsible, offers one explicit paid action, and matches the minimal design", () => {
  const html = page(indexed, history());
  assert.match(html, /<details class="panel assessment"><summary>Lead Intake Assessment<\/summary>/);
  assert.match(html, /Status: <strong>Not generated<\/strong>/);
  assert.match(html, new RegExp(`<form method="post" action="/assessment"[^>]*>\\s*<input type="hidden" name="prospectId" value="${INDEXED}">`));
  assert.match(html, /<button type="submit" name="confirm" value="generate-assessment">Generate Assessment<\/button>/);
  assert.match(html, /Firecrawl will not run/);
  assert.doesNotMatch(html, /<script|<link|<img|<iframe/i);
  // The CSP still names exactly the inline stylesheet, including the new rules.
  const style = /<style>([\s\S]*)<\/style>/.exec(html)![1]!;
  assert.match(DASHBOARD_CSP, new RegExp(createHash("sha256").update(style).digest("base64").replace(/[+/=]/g, "\\$&")));
  assert.match(style, /\.assessment-body/);

  const unavailable = page(bare, null);
  assert.match(unavailable, /Assessments are available after this prospect has indexed website research/);
  assert.doesNotMatch(unavailable, /Generate Assessment/);
});

test("a completed assessment shows summary, fit, verified quotes, hypotheses, unknowns, and questions", () => {
  const html = page(indexed, history(record()));
  assert.match(html, /<details class="panel assessment" open>/);
  assert.match(html, /Status: <strong>Current<\/strong>/);
  assert.doesNotMatch(html, /Generate Assessment/);
  assert.match(html, /This assessment matches the current research/);
  for (const heading of ["Preliminary prospect fit", "Business intake summary", "Primary opportunity hypothesis", "Primary discovery question", "Top opportunities to investigate"])
    assert.ok(html.includes(`<h3>${heading}</h3>`), heading);
  assert.match(html, /<span class="grade">A<\/span>/);
  assert.match(html, /Several distinct signals of operational complexity are verified/);
  assert.match(html, /rubric n8n-prospecting-fit-v5/);
  assert.match(html, /<h4>Verified signals behind the grade<\/h4>/);
  assert.match(html, /Complexity signal<\/span> <strong>Multiple customer-intake paths<\/strong>/);
  assert.match(html, /<h4>Still unclear<\/h4>/);
  assert.match(html, /Observed \(verified\)<\/span>/);
  for (const label of ["Phone intake and contact availability", "Website forms and service requests", "Online scheduling and booking", "After-hours and emergency intake", "Lead acknowledgment and follow-up", "CRM, field-service software, and integrations"])
    assert.ok(html.includes(`<summary>${label}</summary>`), label);
  assert.match(html, /<blockquote>Call 555-0100 to reach our office\.<\/blockquote>/);
  assert.match(html, /<a href="https:\/\/riverbend\.example\.com\/contact" target="_blank" rel="noreferrer">/);
  // Only https URLs become links.
  assert.doesNotMatch(html, /href="http:\/\/insecure/);
  assert.match(html, /http:\/\/insecure\.example\.com\//);
  assert.match(html, /Hypothesis, not verified/);
  assert.match(html, /<h4>Unknown<\/h4>/);
  assert.match(html, /<h4>Possible Relay opportunities \(hypotheses\)<\/h4>/);
  assert.match(html, /<h4>Discovery questions<\/h4>/);
  assert.match(html, /not a diagnosis of the business's operations/);
  assert.match(html, /never as a shortcoming/);
});

test("model text is escaped, withheld parts explain themselves, and an old result version is not rendered", () => {
  const hostile = structuredClone(built.result);
  hostile.primaryDiscoveryQuestion = '<script>alert("x")</script>';
  hostile.categories[0]!.observations[0]!.citations[0]!.quote = "<img src=x onerror=alert(1)>";
  hostile.categories[0]!.observations[0]!.citations[0]!.sourceUrl = 'https://riverbend.example.com/"><script>';
  hostile.fit = { ...hostile.fit, grade: "Unassessed", basis: "insufficient_evidence", rationale: "Not enough: <b>reason</b>", signals: [], unknowns: [{ id: "lead_volume", text: "<i>unclear</i>" }] };
  hostile.unconfirmed = [{ scope: "observation", id: "online_booking_offered", label: "<b>Online booking</b>", citations: [{ sourceId: "S1", sourceUrl: "javascript:alert(1)", chunkId: "c", quote: "<u>Online booking coming soon.</u>" }] }];
  hostile.sources = [{ sourceId: "S1", sourceUrl: "https://riverbend.example.com/contact", flagged: true, via: "vector" }];
  hostile.summary = null;
  hostile.primaryOpportunityHypothesis = null;
  hostile.topOpportunities = [];
  hostile.withheld = 2;
  const html = page(indexed, history(record({ result: hostile })));
  assert.doesNotMatch(html, /<script>alert|<img src=x|<b>reason|<i>unclear/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.match(html, /<span class="grade">Unassessed<\/span>/);
  assert.match(html, /Not enough: &lt;b&gt;reason&lt;\/b&gt;/);
  assert.match(html, /No observation could be verified from the retrieved excerpts, so there is no summary/);
  // Unconfirmed claims are shown as such, escaped, with non-https sources as plain text.
  assert.match(html, /<h3>Unconfirmed<\/h3>/);
  assert.match(html, /&lt;b&gt;Online booking&lt;\/b&gt;/);
  assert.match(html, /&lt;u&gt;Online booking coming soon\.&lt;\/u&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /<b>Online booking|<u>Online/);
  assert.match(html, /A source excerpt contained instruction-like text\. It was treated as evidence only/);
  assert.match(html, /The drafted hypothesis was withheld/);
  assert.match(html, /No opportunity met the evidence and hypothesis standards/);
  assert.match(html, /2 model outputs were withheld because the quote did not support the claim/);

  const noQuestion = structuredClone(built.result);
  noQuestion.primaryDiscoveryQuestion = null;
  assert.match(page(indexed, history(record({ result: noQuestion }))), /did not meet the discovery question standard/);

  // A version-2 row with an unexpected inner shape falls back instead of throwing.
  const odd = page(indexed, history(record({ result: { ...built.result, categories: [null], fit: { signals: [], unknowns: [] } } })));
  assert.match(odd, /could not be displayed/);
  assert.match(odd, /Lead Intake Assessment/);

  for (const schemaVersion of [1, 2]) {
    const old = page(indexed, history(record({ result: { schemaVersion } })));
    assert.match(old, /could not be displayed/);
    assert.doesNotMatch(old, /<h3>Preliminary prospect fit/);
  }
  const old = page(indexed, history(record({ result: { schemaVersion: 1 } })));
  assert.match(old, /could not be displayed/);
  assert.doesNotMatch(old, /<h3>Preliminary prospect fit/);
});

test("status reflects research changes, held runs, and in-flight generation", () => {
  const outdated = page(indexed, history(record({ outdated: true, evidenceFingerprint: "e".repeat(64) })));
  assert.match(outdated, /Status: <strong>Outdated<\/strong>/);
  assert.match(outdated, /The research or the fit rubric has changed since this assessment was generated/);
  assert.match(outdated, /Regenerate Assessment/);
  // History is still shown while it is outdated.
  assert.match(outdated, /<h3>Business intake summary<\/h3>/);

  const held = page(indexed, history(record({ id: "r2", status: "needs_review", result: null, lastError: "x", createdAt: new Date("2026-11-13T19:00:00Z") }), record()));
  assert.match(held, /Status: <strong>Needs review<\/strong>/);
  assert.match(held, /was held for review and was not retried/);
  assert.doesNotMatch(held, /name="confirm" value="generate-assessment"/);
  assert.match(held, /Assessment history: 2/);

  const failed = page(indexed, history(record({ status: "failed", result: null })));
  assert.match(failed, /Status: <strong>Failed<\/strong>/);
  assert.match(failed, /nothing was saved from it/);
  assert.match(failed, /Generate Assessment/);

  const generating = page(indexed, history(record({ status: "generating", result: null })));
  assert.match(generating, /Status: <strong>Generating<\/strong>/);
  assert.match(generating, /http-equiv="refresh" content="1"/);
  assert.doesNotMatch(generating, /name="confirm" value="generate-assessment"/);
  assert.doesNotMatch(html(indexed), /http-equiv="refresh"/);

  const capped = page(indexed, history(...[1, 2, 3].map((n) => record({ id: `f${n}`, status: "failed", result: null }))));
  assert.match(capped, /reached the limit/);
  assert.doesNotMatch(capped, /Generate Assessment/);

  function html(selected: DashboardProspect) {
    return page(selected, history(record()));
  }
});

test("POST /assessment requires a same-origin, confirmed request for an indexed prospect and launches once", async (t) => {
  const generated: string[] = [];
  const events: IntakeServerEvent[] = [];
  let finish!: () => void;
  let fail = false;
  const server = await startIntakeServer({
    port: 0,
    createProspect: async () => { throw new Error("unexpected"); },
    log: (event) => events.push(event),
    dashboard: {
      listProspects: async () => prospects,
      render: renderDashboard,
      csp: DASHBOARD_CSP,
      loadAssessment: async () => history(),
      generateAssessment: (prospectId) => {
        generated.push(prospectId);
        return new Promise((resolve, reject) => { finish = () => (fail ? reject(new Error("provider said sk-secret-123")) : resolve(undefined)); });
      },
      askHandler: (getServer) => createAskRelayHandler({ listProspects: async () => [], ask: async () => { throw new Error("unexpected"); } }, getServer, { dashboard: true }),
    },
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const send = (path: string, body?: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; location: string | undefined; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { origin, "content-type": "application/x-www-form-urlencoded", ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, location: res.headers.location, body: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject);
      req.end(body);
    });
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  const confirmed = form({ prospectId: INDEXED, confirm: "generate-assessment" });

  assert.equal((await send("/assessment")).status, 405);
  assert.equal((await send("/assessment", confirmed, { origin: "https://evil.example" })).status, 403);
  assert.equal((await send("/assessment", confirmed, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await send("/assessment", form({ prospectId: INDEXED }))).status, 400);
  assert.equal((await send("/assessment", form({ prospectId: INDEXED, confirm: "ask-relay" }))).status, 400);
  assert.equal((await send("/assessment", form({ prospectId: "bad", confirm: "generate-assessment" }))).status, 400);
  assert.equal((await send("/assessment", form({ prospectId: INDEXED, confirm: "generate-assessment", extra: "1" }))).status, 400);
  assert.equal((await send("/assessment", form({ prospectId: BARE, confirm: "generate-assessment" }))).status, 409);
  assert.equal((await send("/assessment", form({ prospectId: "00000000-0000-4000-a000-0000000000ff", confirm: "generate-assessment" }))).status, 409);
  assert.deepEqual(generated, []);

  const first = await send("/assessment", confirmed);
  assert.equal(first.status, 303);
  assert.equal(first.location, `/prospect?id=${INDEXED}`);
  // A double click while the run is in flight does not launch a second one.
  assert.equal((await send("/assessment", confirmed)).status, 303);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(generated, [INDEXED]);

  const shown = await send(first.location!);
  assert.equal(shown.status, 200);
  assert.match(shown.body, /Lead Intake Assessment/);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events.filter((event) => event.event.startsWith("assessment")).map((event) => event.event), ["assessment_requested", "assessment_finished"]);

  // After it settles, the server relies on the durable reservation to refuse or reuse.
  fail = true;
  assert.equal((await send("/assessment", confirmed)).status, 303);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(generated.length, 2);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stopped = events.find((event) => event.event === "assessment_stopped");
  assert.deepEqual(stopped, { event: "assessment_stopped", prospectId: INDEXED, error: "Error" });
  assert.ok(!JSON.stringify(events).includes("sk-secret"));
});

test("without assessment dependencies the dashboard serves no assessment action", async (t) => {
  const server = await startIntakeServer({
    port: 0,
    createProspect: async () => { throw new Error("unexpected"); },
    dashboard: {
      listProspects: async () => prospects,
      render: renderDashboard,
      csp: DASHBOARD_CSP,
      askHandler: (getServer) => createAskRelayHandler({ listProspects: async () => [], ask: async () => { throw new Error("unexpected"); } }, getServer, { dashboard: true }),
    },
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const result = await new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/assessment", method: "POST", headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/x-www-form-urlencoded" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    req.on("error", reject);
    req.end(new URLSearchParams({ prospectId: INDEXED, confirm: "generate-assessment" }).toString());
  });
  assert.equal(result, 404);
});

test("quotes read cleanly: verified telephone and website links show their label, and the rest stays escaped text", () => {
  const result = JSON.parse(JSON.stringify(built.result));
  const link = "[908-555-0142](tel:+19085550142)";
  result.fit.signals[0].citations[0].quote = `Call ${link} or [use the form](https://riverbend.example.com/contact) <b>now</b>`;
  result.fit.signals[1].citations[0].quote = "Call [908-555-0142](tel:+19998887777) or [x](javascript:alert(1))";
  const html = page(indexed, history(record({ result })));

  assert.match(html, /<blockquote>Call 908-555-0142 or use the form &lt;b&gt;now&lt;\/b&gt;<\/blockquote>/);
  // A link that dials another number, and any other scheme, are shown as written, as inert text.
  assert.match(html, /<blockquote>Call \[908-555-0142\]\(tel:\+19998887777\) or \[x\]\(javascript:alert\(1\)\)<\/blockquote>/);
  assert.ok(!/href="(?:tel|javascript):/i.test(html));
  assert.ok(!html.includes(link));
  // What is stored is untouched.
  assert.equal(result.fit.signals[0].citations[0].quote.includes(link), true);
});
