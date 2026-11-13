import { strict as assert } from "node:assert";
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { IndexedProspect } from "../../src/data/research-embeddings.js";
import type { AskRelayResult } from "../../src/research/ask-relay.js";
import {
  MAX_ASK_FORM_BYTES,
  MAX_RUNNING_ASKS,
  parseAskUiPort,
  startAskRelayServer,
  validateQuestion,
  type AskServerDependencies,
  type AskServerEvent,
} from "../../src/web/ask-relay-server.js";

const PROSPECT: IndexedProspect = {
  id: "00000000-0000-4000-a000-000000000001",
  companyName: "Riverbend Comfort",
  website: "https://riverbend.example.com/",
  embeddedChunks: 3,
};
const OTHER: IndexedProspect = {
  id: "00000000-0000-4000-a000-000000000002",
  companyName: "Oak Hollow Counseling",
  website: "https://oakhollow.example.com/",
  embeddedChunks: 2,
};
const ID = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const answered = (question: string): AskRelayResult => ({
  question,
  status: "answered",
  reason: null,
  answer: "They serve Riverbend.",
  citations: [{ sourceId: "S1", sourceUrl: "https://riverbend.example.com/", quote: "We serve Riverbend" }],
  retrieved: [{ sourceId: "S1", sourceUrl: "https://riverbend.example.com/", similarity: 0.42 }],
});

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };
type Deferred = { resolve: (value: AskRelayResult) => void; reject: (error: unknown) => void };
type Harness = {
  port: number;
  origin: string;
  asks: { prospectId: string; question: string }[];
  pending: Deferred[];
  events: AskServerEvent[];
};

// Each ask stays pending until the test settles it, so in-flight states are observable.
async function startHarness(t: TestContext, overrides: Partial<AskServerDependencies> = {}): Promise<Harness> {
  const asks: Harness["asks"] = [];
  const pending: Deferred[] = [];
  const events: AskServerEvent[] = [];
  let next = 0;
  const server = await startAskRelayServer({
    port: 0,
    listProspects: async () => [PROSPECT, OTHER],
    ask: (input) => {
      asks.push(input);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    generateAskId: () => ID(++next),
    log: (event) => events.push(event),
    ...overrides,
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { port, origin: `http://127.0.0.1:${port}`, asks, pending, events };
}

function send(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string | number | undefined>; body?: string | Buffer },
): Promise<Reply> {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) if (value !== undefined) headers[name] = value;
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path ?? "/", headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const get = (harness: Harness, path: string, headers: Record<string, string> = {}) =>
  send(harness.port, { path, headers: { host: `127.0.0.1:${harness.port}`, ...headers } });

function post(
  harness: Harness,
  fields: Record<string, string> | string | Buffer,
  headers: Record<string, string | undefined> = {},
): Promise<Reply> {
  const body = typeof fields === "string" || Buffer.isBuffer(fields) ? fields : new URLSearchParams(fields).toString();
  return send(harness.port, {
    method: "POST",
    path: "/ask",
    body,
    headers: {
      host: `127.0.0.1:${harness.port}`,
      origin: harness.origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
      "content-length": Buffer.byteLength(body),
      ...headers,
    },
  });
}

const form = (overrides: Record<string, string> = {}) => ({
  askId: ID(100),
  prospectId: PROSPECT.id,
  question: "  Which towns do you serve?  ",
  confirm: "ask-relay",
  ...overrides,
});
// Lets the server observe a settled ask before the next request.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("The form page lists only indexed prospects and is served with strict headers", async (t) => {
  const harness = await startHarness(t);
  const reply = await get(harness, "/");
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["cache-control"], "no-store");
  assert.equal(reply.headers["x-content-type-options"], "nosniff");
  assert.equal(reply.headers["x-frame-options"], "DENY");
  assert.match(String(reply.headers["content-security-policy"]), /^default-src 'none'; style-src 'sha256-/);
  assert.match(reply.body, /Riverbend Comfort \(3 chunks\)/);
  assert.match(reply.body, /Oak Hollow Counseling \(2 chunks\)/);
  assert.match(reply.body, new RegExp(`name="askId" value="${ID(1)}"`));
  assert.equal((await get(harness, "/healthz")).body, "ok\n");
});

test("Unknown paths, wrong methods, and foreign Host headers are refused", async (t) => {
  const harness = await startHarness(t);
  assert.equal((await get(harness, "/admin")).status, 404);
  const wrongMethod = await send(harness.port, {
    method: "POST",
    path: "/",
    headers: { host: `127.0.0.1:${harness.port}` },
  });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "GET");
  assert.equal((await get(harness, "/ask")).status, 405);
  // DNS rebinding: a request addressed to another host name is not served.
  assert.equal((await get(harness, "/", { host: "evil.example.com" })).status, 403);
  assert.equal((await post(harness, form(), { host: "evil.example.com" })).status, 403);
  assert.equal(harness.asks.length, 0);
});

test("Only same-origin, well-formed, confirmed form posts can ask", async (t) => {
  const harness = await startHarness(t);
  const cases: [number, Promise<Reply>][] = [
    [403, post(harness, form(), { origin: "https://evil.example.com" })],
    [403, post(harness, form(), { origin: undefined })],
    [403, post(harness, form(), { "sec-fetch-site": "cross-site" })],
    [415, post(harness, form(), { "content-type": "application/json" })],
    [413, post(harness, form({ question: "x".repeat(MAX_ASK_FORM_BYTES) }))],
    [400, post(harness, `${new URLSearchParams(form())}&extra=1`)],
    [400, post(harness, `${new URLSearchParams(form())}&question=again`)],
    [400, post(harness, Buffer.from([0x71, 0x75, 0x65, 0x73, 0x74, 0x69, 0x6f, 0x6e, 0x3d, 0xff]))],
    [400, post(harness, form({ confirm: "yes" }))],
    [400, post(harness, form({ askId: "not-a-uuid" }))],
  ];
  for (const [status, reply] of cases) assert.equal((await reply).status, status);
  assert.equal(harness.asks.length, 0);
});

test("Invalid prospects and questions re-render the form with escaped input and ask nothing", async (t) => {
  const harness = await startHarness(t);
  const unknown = await post(harness, form({ prospectId: "00000000-0000-4000-a000-000000000099" }));
  assert.equal(unknown.status, 422);
  assert.match(unknown.body, /Choose one of the listed prospects/);
  for (const [question, message] of [
    ["   ", /Enter a question/],
    ["x".repeat(501), /at most 500 characters/],
    ["bell\u0007", /characters Relay cannot accept/],
  ] as const) {
    const reply = await post(harness, form({ question }));
    assert.equal(reply.status, 422);
    assert.match(reply.body, message);
  }
  const hostile = await post(harness, form({ question: "<script>x</script>", prospectId: "bad" }));
  assert.ok(hostile.body.includes("&lt;script&gt;x&lt;/script&gt;"));
  assert.ok(!hostile.body.includes("<script>x"));
  assert.equal(harness.asks.length, 0);
});

test("A valid question redirects to its answer page, which polls until the answer is ready", async (t) => {
  const harness = await startHarness(t);
  const submitted = await post(harness, form());
  assert.equal(submitted.status, 303);
  assert.equal(submitted.headers.location, `/answer?id=${ID(100)}`);
  assert.deepEqual(harness.asks, [{ prospectId: PROSPECT.id, question: "Which towns do you serve?" }]);

  const pending = await get(harness, `/answer?id=${ID(100)}`);
  assert.equal(pending.status, 200);
  assert.match(pending.body, /<meta http-equiv="refresh" content="1">/);
  assert.match(pending.body, /Searching this prospect's research/);

  harness.pending[0]!.resolve(answered("Which towns do you serve?"));
  await settle();
  const done = await get(harness, `/answer?id=${ID(100)}`);
  assert.match(done.body, /<h2>Answer<\/h2>/);
  assert.match(done.body, /They serve Riverbend\./);
  assert.match(done.body, /<blockquote>We serve Riverbend<\/blockquote>/);
  assert.match(done.body, /href="https:\/\/riverbend\.example\.com\/"/);
  // The next question is preselected for the same prospect, with a fresh form ID.
  assert.match(done.body, new RegExp(`<option value="${PROSPECT.id}" selected>`));
  assert.doesNotMatch(done.body, /<meta http-equiv="refresh"/);
  assert.deepEqual(
    harness.events.map((event) => event.event),
    ["ask_started", "ask_finished"],
  );
});

test("Insufficient evidence is rendered as such", async (t) => {
  const harness = await startHarness(t);
  await post(harness, form({ prospectId: OTHER.id, question: "Which insurance plans?" }));
  harness.pending[0]!.resolve({
    question: "Which insurance plans?",
    status: "insufficient_evidence",
    reason: "model_reported",
    answer: "The excerpts do not mention insurance.",
    citations: [],
    retrieved: [],
  });
  await settle();
  const page = await get(harness, `/answer?id=${ID(100)}`);
  assert.match(page.body, /<h2>Not enough evidence<\/h2>/);
  assert.match(page.body, /do not mention insurance/);
  assert.doesNotMatch(page.body, /Sources and verified quotes/);
});

test("Resubmitting the same form never asks twice; an edited resubmission is a new question", async (t) => {
  const harness = await startHarness(t);
  const first = await post(harness, form());
  const repeat = await post(harness, form());
  assert.equal(repeat.headers.location, first.headers.location);
  assert.equal(harness.asks.length, 1);

  const edited = await post(harness, form({ question: "Do you offer emergency service?" }));
  assert.equal(edited.status, 303);
  assert.notEqual(edited.headers.location, first.headers.location);
  assert.equal(harness.asks.length, 2);
});

test("Failures show fixed text and log only the error kind", async (t) => {
  const harness = await startHarness(t);
  await post(harness, form());
  harness.pending[0]!.reject(new Error("provider said: secret-token-123 and chunk text"));
  await settle();
  const page = await get(harness, `/answer?id=${ID(100)}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /Relay could not answer this question/);
  assert.doesNotMatch(page.body, /secret-token|chunk text/);
  assert.deepEqual(harness.events.at(-1), { event: "ask_failed", askId: ID(100), error: "Error" });

  const broken = await startHarness(t, {
    listProspects: async () => {
      throw new Error("connect ECONNREFUSED secret-host");
    },
  });
  const reply = await get(broken, "/");
  assert.equal(reply.status, 500);
  assert.doesNotMatch(reply.body, /secret-host|ECONNREFUSED/);
  assert.deepEqual(broken.events, [{ event: "request_failed", error: "Error" }]);
});

test("Unknown answers are not found, and paid calls in flight are bounded", async (t) => {
  const harness = await startHarness(t);
  assert.equal((await get(harness, `/answer?id=${ID(999)}`)).status, 404);
  assert.equal((await get(harness, "/answer?id=../../etc")).status, 404);

  for (let n = 0; n < MAX_RUNNING_ASKS; n++)
    assert.equal((await post(harness, form({ askId: ID(200 + n) }))).status, 303);
  const busy = await post(harness, form({ askId: ID(300) }));
  assert.equal(busy.status, 429);
  assert.match(busy.body, /Relay is busy/);
  assert.equal(harness.asks.length, MAX_RUNNING_ASKS);

  harness.pending[0]!.resolve(answered("Which towns do you serve?"));
  await settle();
  assert.equal((await post(harness, form({ askId: ID(301) }))).status, 303);
});

test("Port and question validation", () => {
  assert.equal(parseAskUiPort(undefined), 4311);
  assert.equal(parseAskUiPort("8080"), 8080);
  for (const value of ["0", "65536", "80a", "", "-1"]) assert.throws(() => parseAskUiPort(value));
  assert.deepEqual(validateQuestion("  Hello?\r\n "), { question: "Hello?" });
  assert.deepEqual(validateQuestion("Line one\r\nLine two"), { question: "Line one\r\nLine two" });
  assert.ok("error" in validateQuestion(""));
  assert.ok("question" in validateQuestion("x".repeat(500)));
  assert.ok("error" in validateQuestion("x".repeat(501)));
});
