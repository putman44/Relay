import { strict as assert } from "node:assert";
import {
  request,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import {
  ProspectIntakeConflictError,
  type ProspectIntakeInput,
  type ProspectIntakeResult,
} from "../../src/intake/prospect-intake.js";
import type { ResearchSummary } from "../../src/web/intake-pages.js";
import {
  MAX_INTAKE_FORM_BYTES,
  parseIntakeUiPort,
  startIntakeServer,
  type IntakeResearchDependencies,
  type IntakeServerDependencies,
  type IntakeServerEvent,
} from "../../src/web/intake-server.js";

const REQUEST_ID = "6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d";
const PROSPECT_ID = "0b5d7e3a-9c41-4b8f-a2d6-31e5f7c9a804";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Distinctive markers let the leak checks prove submitted input stays out of a page.
const rawFields = {
  requestId: REQUEST_ID,
  companyName: "  Dev By Taylor  ",
  website: "https://devbytaylor.com",
  industry: " Software ",
  contactName: "",
  contactEmail: "Private.Contact@DevByTaylor.com",
  primaryDiscoveryQuestion: "Confidential: how are new inquiries handled?",
};
const normalized: ProspectIntakeInput = {
  requestId: REQUEST_ID,
  companyName: "Dev By Taylor",
  website: "https://devbytaylor.com/",
  industry: "Software",
  contactName: null,
  contactEmail: "private.contact@devbytaylor.com",
  primaryDiscoveryQuestion: "Confidential: how are new inquiries handled?",
};
const confirmed = (fields: Record<string, string>) => ({
  ...fields,
  confirm: "create-prospect",
});

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };
type Harness = {
  port: number;
  origin: string;
  calls: ProspectIntakeInput[];
  events: IntakeServerEvent[];
  server: Server;
};

async function startHarness(
  t: TestContext,
  overrides: Partial<IntakeServerDependencies> = {},
): Promise<Harness> {
  const calls: ProspectIntakeInput[] = [];
  const events: IntakeServerEvent[] = [];
  const create =
    overrides.createProspect ??
    (async (input: ProspectIntakeInput): Promise<ProspectIntakeResult> => ({
      requestId: input.requestId,
      prospectId: PROSPECT_ID,
      stage: "researching",
      created: true,
    }));
  const server = await startIntakeServer({
    port: 0,
    generateRequestId: () => REQUEST_ID,
    log: (event) => events.push(event),
    ...overrides,
    createProspect: async (input) => {
      calls.push(input);
      return create(input);
    },
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { port, origin: `http://127.0.0.1:${port}`, calls, events, server };
}

function send(
  port: number,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string | number | undefined>;
    body?: string | Buffer;
  },
): Promise<Reply> {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(options.headers ?? {}))
    if (value !== undefined) headers[name] = value;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

function post(
  harness: Harness,
  path: string,
  fields: Record<string, string> | string | Buffer,
  headers: Record<string, string | undefined> = {},
): Promise<Reply> {
  const body =
    typeof fields === "string" || Buffer.isBuffer(fields)
      ? fields
      : new URLSearchParams(fields).toString();
  return send(harness.port, {
    method: "POST",
    path,
    body,
    headers: {
      origin: harness.origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
  });
}

const unescapeHtml = (value: string) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [, name, value] of html.matchAll(
    /<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
  )) {
    fields[name!] = unescapeHtml(value!);
  }
  return fields;
}

const RESEARCH_ID = "3e9a1c57-2b6d-4f80-9a1e-5c7d2f4b6a90";
const STATUS_PATH = `/research?prospectId=${PROSPECT_ID}`;
const START_FORM = /<form [^>]*method="post" action="\/research\/start"/;
const REFRESH = '<meta http-equiv="refresh"';
const summary = (
  status: ResearchSummary["status"],
  overrides: Partial<ResearchSummary> = {},
): ResearchSummary => ({
  id: RESEARCH_ID,
  status,
  updated_at: new Date("2026-11-11T10:00:00.000Z"),
  last_error: null,
  brief_url: null,
  ...overrides,
});

// A scripted research workflow: each start stays pending until the test settles it,
// and `stored` plays the durable research request. No database or provider is involved.
function fakeResearch(initial: ResearchSummary | null = null) {
  const started: string[] = [];
  let stored = initial;
  let pending!: {
    resolve: (request: ResearchSummary) => void;
    reject: (error: unknown) => void;
  };
  const research: IntakeResearchDependencies = {
    getRequest: async () => stored,
    start: (prospectId) => {
      started.push(prospectId);
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
      });
    },
  };
  return {
    research,
    started,
    store: (request: ResearchSummary) => {
      stored = request;
    },
    finish: (request: ResearchSummary) => {
      stored = request;
      pending.resolve(request);
    },
    fail: (error: unknown) => pending.reject(error),
  };
}

const confirmedResearch = (prospectId: string) => ({
  prospectId,
  confirm: "start-research-only",
});
const startResearch = (
  harness: Harness,
  fields: Record<string, string> | string = confirmedResearch(PROSPECT_ID),
  headers: Record<string, string | undefined> = {},
) => post(harness, "/research/start", fields, headers);
const researchStatus = (harness: Harness, path = STATUS_PATH) =>
  send(harness.port, { path });

function assertNoSubmittedInput(body: string): void {
  for (const marker of [
    "Dev By Taylor",
    "devbytaylor",
    "DevByTaylor",
    "Private.Contact",
    "Confidential",
    "Software",
  ]) {
    assert.ok(
      !body.includes(marker),
      `page must not echo submitted input (${marker})`,
    );
  }
}

test("Intake UI: GET / renders the form with a server-generated request ID and protective headers", async (t) => {
  const harness = await startHarness(t);
  const reply = await send(harness.port, {});
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(reply.headers["cache-control"], "no-store");
  assert.equal(reply.headers["x-content-type-options"], "nosniff");
  assert.equal(reply.headers["x-frame-options"], "DENY");
  const csp = String(reply.headers["content-security-policy"]);
  for (const directive of [
    "default-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ]) {
    assert.ok(csp.includes(directive), directive);
  }
  assert.match(reply.body, /<form [^>]*method="post" action="\/review"/);
  assert.deepEqual(hiddenFields(reply.body), { requestId: REQUEST_ID });
  for (const name of [
    "companyName",
    "website",
    "industry",
    "contactName",
    "contactEmail",
    "primaryDiscoveryQuestion",
  ]) {
    assert.ok(reply.body.includes(`name="${name}"`), name);
  }
  assert.equal(harness.calls.length, 0);
});

test("Intake UI: the default request ID generator issues a fresh UUID per form", async (t) => {
  const server = await startIntakeServer({
    port: 0,
    createProspect: async () => {
      throw new Error("unused");
    },
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const first = hiddenFields((await send(port, {})).body).requestId!;
  const second = hiddenFields((await send(port, {})).body).requestId!;
  assert.match(first, UUID);
  assert.match(second, UUID);
  assert.notEqual(first, second);
});

test("Intake UI: review shows normalized values and carries the same request ID without creating", async (t) => {
  const harness = await startHarness(t);
  const reply = await post(harness, "/review", rawFields);
  assert.equal(reply.status, 200);
  assert.match(reply.body, /<form [^>]*method="post" action="\/prospects"/);
  assert.ok(reply.body.includes('name="confirm" value="create-prospect"'));
  assert.ok(reply.body.includes('formaction="/edit"'));
  assert.deepEqual(hiddenFields(reply.body), {
    requestId: REQUEST_ID,
    companyName: "Dev By Taylor",
    website: "https://devbytaylor.com/",
    industry: "Software",
    contactName: "",
    contactEmail: "private.contact@devbytaylor.com",
    primaryDiscoveryQuestion: "Confidential: how are new inquiries handled?",
  });
  assert.ok(reply.body.includes("<dd>https://devbytaylor.com/</dd>"));
  assert.equal(harness.calls.length, 0);
});

test("Intake UI: review and creation accept a prospect without a website", async (t) => {
  const harness = await startHarness(t);
  const review = await post(harness, "/review", { ...rawFields, website: "" });
  assert.equal(review.status, 200);
  assert.ok(review.body.includes('<span class="empty">Not provided</span>'));
  const reply = await post(
    harness,
    "/prospects",
    confirmed(hiddenFields(review.body)),
  );
  assert.equal(reply.status, 201);
  assert.equal(harness.calls[0]?.website, null);
});

test("Intake UI: confirming the review creates through intake with the preserved request ID", async (t) => {
  const harness = await startHarness(t);
  const review = await post(harness, "/review", rawFields);
  const reply = await post(
    harness,
    "/prospects",
    confirmed(hiddenFields(review.body)),
  );
  assert.equal(reply.status, 201);
  assert.deepEqual(harness.calls, [normalized]);
  assert.ok(reply.body.includes("Prospect created"));
  assert.ok(reply.body.includes(PROSPECT_ID));
  assert.ok(reply.body.includes(REQUEST_ID));
  assert.deepEqual(harness.events, [
    { event: "intake_created", requestId: REQUEST_ID, prospectId: PROSPECT_ID },
  ]);
});

test("Intake UI: an idempotent repeat shows the authoritative request ID without claiming creation", async (t) => {
  const authoritative = "a2c4e6f8-1b3d-4f5a-8c7e-9d0b1a2c3e4f";
  const harness = await startHarness(t, {
    createProspect: async () => ({
      requestId: authoritative,
      prospectId: PROSPECT_ID,
      stage: "research_review",
      created: false,
    }),
  });
  const reply = await post(harness, "/prospects", confirmed(rawFields));
  assert.equal(reply.status, 200);
  assert.ok(reply.body.includes("Prospect already recorded"));
  assert.ok(!reply.body.includes("Prospect created"));
  assert.ok(reply.body.includes(authoritative));
  assert.ok(reply.body.includes("research_review"));
  assert.deepEqual(harness.events, [
    {
      event: "intake_existing",
      requestId: authoritative,
      prospectId: PROSPECT_ID,
    },
  ]);
});

test("Intake UI: edit returns to the form with the reviewed values and the same request ID", async (t) => {
  const harness = await startHarness(t);
  const review = await post(harness, "/review", rawFields);
  const reply = await post(harness, "/edit", hiddenFields(review.body));
  assert.equal(reply.status, 200);
  assert.match(reply.body, /<form [^>]*action="\/review"/);
  assert.deepEqual(hiddenFields(reply.body), { requestId: REQUEST_ID });
  assert.ok(reply.body.includes('value="Dev By Taylor"'));
  assert.ok(reply.body.includes('value="private.contact@devbytaylor.com"'));
  assert.equal(harness.calls.length, 0);
});

test("Intake UI: validation failures re-render the form with the intake message and create nothing", async (t) => {
  const harness = await startHarness(t);
  const review = await post(harness, "/review", {
    ...rawFields,
    website: "http://devbytaylor.com",
  });
  assert.equal(review.status, 422);
  assert.ok(review.body.includes("Unsafe research URL."));
  assert.deepEqual(hiddenFields(review.body), { requestId: REQUEST_ID });
  assert.ok(review.body.includes('value="http://devbytaylor.com"'));

  const create = await post(
    harness,
    "/prospects",
    confirmed({ ...rawFields, companyName: "   " }),
  );
  assert.equal(create.status, 422);
  assert.ok(create.body.includes("companyName must be nonblank"));
  assert.deepEqual(hiddenFields(create.body), { requestId: REQUEST_ID });
  assert.equal(harness.calls.length, 0);
});

test("Intake UI: creation requires the review confirmation", async (t) => {
  const harness = await startHarness(t);
  for (const fields of [rawFields, { ...rawFields, confirm: "yes" }]) {
    const reply = await post(harness, "/prospects", fields);
    assert.equal(reply.status, 400);
    assertNoSubmittedInput(reply.body);
  }
  assert.equal(harness.calls.length, 0);
});

test("Intake UI: conflicts render a fail-closed inspection page without echoing input", async (t) => {
  const harness = await startHarness(t, {
    createProspect: async () => {
      throw new ProspectIntakeConflictError(
        "A prospect already exists for this website; inspect it instead of creating another.",
      );
    },
  });
  const reply = await post(harness, "/prospects", confirmed(rawFields));
  assert.equal(reply.status, 409);
  assert.ok(reply.body.includes("Relay did not create or change a prospect."));
  assert.ok(
    reply.body.includes(
      "A prospect already exists for this website; inspect it instead of creating another.",
    ),
  );
  assert.ok(reply.body.includes(REQUEST_ID));
  assertNoSubmittedInput(reply.body);
  assert.deepEqual(harness.events, [
    { event: "intake_conflict", requestId: REQUEST_ID },
  ]);
});

test("Intake UI: uncertain creation failures keep the request ID and expose no internal details", async (t) => {
  const failures: unknown[] = [
    Object.assign(
      new Error(
        "duplicate key value violates unique constraint; password=hunter2 private.contact@devbytaylor.com",
      ),
      { code: "23505" },
    ),
    new TypeError(
      'Cannot read properties of undefined (reading "Confidential")',
    ),
    "raw thrown string with Dev By Taylor",
  ];
  for (const failure of failures) {
    const harness = await startHarness(t, {
      createProspect: async () => {
        throw failure;
      },
    });
    const reply = await post(harness, "/prospects", confirmed(rawFields));
    assert.equal(reply.status, 500);
    assert.ok(
      reply.body.includes(
        "Relay could not confirm whether the prospect was created.",
      ),
    );
    assert.ok(reply.body.includes(REQUEST_ID));
    assert.ok(
      reply.body.includes(
        "Do not start a new intake and do not change any values.",
      ),
    );
    for (const internal of [
      "duplicate key",
      "hunter2",
      "Cannot read",
      "raw thrown",
      "23505",
    ]) {
      assert.ok(!reply.body.includes(internal), internal);
    }
    assertNoSubmittedInput(reply.body);
    assert.equal(harness.events.length, 1);
    assert.equal(harness.events[0]!.event, "intake_outcome_unknown");
    assertNoSubmittedInput(JSON.stringify(harness.events));
    assert.ok(!JSON.stringify(harness.events).includes("hunter2"));
  }
});

test("Intake UI: unexpected failures outside creation render a generic page", async (t) => {
  const harness = await startHarness(t, {
    generateRequestId: () => {
      throw new Error("secret internal detail");
    },
  });
  const reply = await send(harness.port, {});
  assert.equal(reply.status, 500);
  assert.ok(!reply.body.includes("secret internal detail"));
  assert.deepEqual(harness.events, [
    { event: "request_failed", error: "Error" },
  ]);
});

test("Intake UI: HTML output escapes submitted values", async (t) => {
  const harness = await startHarness(t);
  const hostile = {
    ...rawFields,
    companyName: '<script>alert("x")</script> & Sons',
    industry: '"><img src=x onerror=alert(1)>',
    primaryDiscoveryQuestion: "</textarea><b>it's</b>",
  };
  const review = await post(harness, "/review", hostile);
  assert.equal(review.status, 200);
  const invalid = await post(harness, "/review", {
    ...hostile,
    website: "not a url",
  });
  assert.equal(invalid.status, 422);
  for (const body of [review.body, invalid.body]) {
    assert.ok(!body.includes("<script>alert"));
    assert.ok(!body.includes('"><img'));
    assert.ok(!body.includes("</textarea><b>"));
    assert.ok(
      body.includes(
        "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Sons",
      ),
    );
    assert.ok(body.includes("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"));
    assert.ok(body.includes("&lt;/textarea&gt;&lt;b&gt;it&#39;s&lt;/b&gt;"));
  }
  assert.equal(hiddenFields(review.body).companyName, hostile.companyName);
});

test("Intake UI: cross-origin, unverified-origin and rebinding requests are rejected", async (t) => {
  const harness = await startHarness(t);
  const rejected: Record<string, string | undefined>[] = [
    { origin: "https://evil.example" },
    { origin: undefined },
    { origin: "null" },
    { origin: `http://localhost:${harness.port}` },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    {
      host: `evil.example:${harness.port}`,
      origin: `http://evil.example:${harness.port}`,
    },
  ];
  for (const headers of rejected) {
    for (const path of ["/review", "/edit", "/prospects"]) {
      const reply = await post(harness, path, confirmed(rawFields), headers);
      assert.equal(reply.status, 403, `${path} ${JSON.stringify(headers)}`);
      assertNoSubmittedInput(reply.body);
    }
  }
  const rebound = await send(harness.port, {
    headers: { host: `evil.example:${harness.port}` },
  });
  assert.equal(rebound.status, 403);
  assert.equal(harness.calls.length, 0);

  // Same-origin requests through the localhost name remain usable.
  const local = await post(harness, "/review", rawFields, {
    host: `localhost:${harness.port}`,
    origin: `http://localhost:${harness.port}`,
    "sec-fetch-site": undefined,
  });
  assert.equal(local.status, 200);
});

test("Intake UI: request bodies over the size limit are rejected", async (t) => {
  const harness = await startHarness(t);
  const declared = await new Promise<number>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: harness.port,
        method: "POST",
        path: "/prospects",
        agent: false,
        headers: {
          origin: harness.origin,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": MAX_INTAKE_FORM_BYTES + 1,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
        req.destroy();
      },
    );
    req.on("error", reject);
    req.flushHeaders();
  });
  assert.equal(declared, 413);

  const streamed = await new Promise<number>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: harness.port,
        method: "POST",
        path: "/prospects",
        agent: false,
        headers: {
          origin: harness.origin,
          "content-type": "application/x-www-form-urlencoded",
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
        req.destroy();
      },
    );
    req.on("error", reject);
    req.write(
      `confirm=create-prospect&companyName=${"a".repeat(MAX_INTAKE_FORM_BYTES)}`,
    );
  });
  assert.equal(streamed, 413);
  assert.equal(harness.calls.length, 0);

  const within = await post(harness, "/review", {
    ...rawFields,
    primaryDiscoveryQuestion: "q".repeat(1000),
  });
  assert.equal(within.status, 200);
});

test("Intake UI: unsupported content types and malformed forms are rejected", async (t) => {
  const harness = await startHarness(t);
  const json = await post(
    harness,
    "/prospects",
    JSON.stringify(confirmed(rawFields)),
    { "content-type": "application/json" },
  );
  assert.equal(json.status, 415);
  const multipart = await post(harness, "/review", "x", {
    "content-type": "multipart/form-data; boundary=x",
  });
  assert.equal(multipart.status, 415);
  const malformed: (Record<string, string> | string | Buffer)[] = [
    { ...confirmed(rawFields), surprise: "yes" },
    `${new URLSearchParams(confirmed(rawFields))}&companyName=Second`,
    Buffer.concat([
      Buffer.from(`${new URLSearchParams(confirmed(rawFields))}&industry=`),
      Buffer.from([0xff, 0xfe]),
    ]),
  ];
  for (const body of malformed) {
    const reply = await post(harness, "/prospects", body);
    assert.equal(reply.status, 400);
    assertNoSubmittedInput(reply.body);
  }
  const confirmOnReview = await post(harness, "/review", confirmed(rawFields));
  assert.equal(confirmOnReview.status, 400);
  assert.equal(harness.calls.length, 0);
});

test("Intake UI: health, unknown routes and wrong methods", async (t) => {
  const harness = await startHarness(t);
  const health = await send(harness.port, { path: "/healthz" });
  assert.equal(health.status, 200);
  assert.equal(health.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(health.body, "ok\n");

  assert.equal((await send(harness.port, { path: "/missing" })).status, 404);
  assert.equal(
    (
      await send(harness.port, {
        path: "http://127.0.0.1/review",
        method: "POST",
      })
    ).status,
    404,
  );
  for (const [method, path, allow] of [
    ["PUT", "/", "GET"],
    ["POST", "/healthz", "GET"],
    ["GET", "/prospects", "POST"],
    ["GET", "/review", "POST"],
  ] as const) {
    const reply = await send(harness.port, {
      method,
      path,
      headers: { origin: harness.origin },
    });
    assert.equal(reply.status, 405, `${method} ${path}`);
    assert.equal(reply.headers.allow, allow);
  }
  assert.equal(harness.calls.length, 0);
});

test("Intake UI: the server listens only on loopback", async (t) => {
  const harness = await startHarness(t);
  const address = harness.server.address() as AddressInfo;
  assert.equal(address.address, "127.0.0.1");
  assert.equal(address.family, "IPv4");
});

test("Intake UI: the port setting accepts only explicit TCP ports", () => {
  assert.equal(parseIntakeUiPort(undefined), 4310);
  assert.equal(parseIntakeUiPort("8080"), 8080);
  assert.equal(parseIntakeUiPort("65535"), 65535);
  for (const value of [
    "",
    "0",
    "65536",
    "080",
    " 8080",
    "8080 ",
    "80.5",
    "-1",
    "abc",
    "1e3",
  ]) {
    assert.throws(
      () => parseIntakeUiPort(value),
      /RELAY_INTAKE_UI_PORT/,
      JSON.stringify(value),
    );
  }
});

test("Intake UI: the success page offers Start Research for a new prospect without starting it", async (t) => {
  const fake = fakeResearch();
  const harness = await startHarness(t, { research: fake.research });
  const reply = await post(harness, "/prospects", confirmed(rawFields));
  assert.equal(reply.status, 201);
  assert.match(reply.body, START_FORM);
  assert.ok(
    reply.body.includes(
      '<button type="submit" name="confirm" value="start-research-only">Start Research</button>',
    ),
  );
  assert.deepEqual(hiddenFields(reply.body), { prospectId: PROSPECT_ID });
  assert.ok(reply.body.includes("It does not create or send email."));
  assert.deepEqual(fake.started, []);
  assert.deepEqual(harness.events, [
    { event: "intake_created", requestId: REQUEST_ID, prospectId: PROSPECT_ID },
  ]);
});

test("Intake UI: Start Research is offered only while a researchable prospect still awaits research", async (t) => {
  const unconfigured = await startHarness(t);
  const plain = await post(unconfigured, "/prospects", confirmed(rawFields));
  assert.equal(plain.status, 201);
  assert.ok(!plain.body.includes("/research"));
  assert.ok(!plain.body.includes("Start Research"));

  const fake = fakeResearch();
  const harness = await startHarness(t, { research: fake.research });
  const noWebsite = await post(
    harness,
    "/prospects",
    confirmed({ ...rawFields, website: "" }),
  );
  assert.equal(noWebsite.status, 201);
  assert.doesNotMatch(noWebsite.body, START_FORM);
  assert.ok(noWebsite.body.includes("Research needs a website"));

  for (const stage of [
    "research_in_progress",
    "research_review",
    "needs_contact",
    "draft_ready",
  ] as const) {
    const researched = await startHarness(t, {
      research: fake.research,
      createProspect: async (input) => ({
        requestId: input.requestId,
        prospectId: PROSPECT_ID,
        stage,
        created: false,
      }),
    });
    const reply = await post(researched, "/prospects", confirmed(rawFields));
    assert.equal(reply.status, 200);
    assert.doesNotMatch(reply.body, START_FORM, stage);
    assert.ok(!reply.body.includes("Start Research"), stage);
    assert.ok(reply.body.includes(`<a href="${STATUS_PATH}">`), stage);
  }

  const recorded = await startHarness(t, {
    research: fake.research,
    createProspect: async (input) => ({
      requestId: input.requestId,
      prospectId: PROSPECT_ID,
      stage: "researching",
      created: false,
    }),
  });
  const again = await post(recorded, "/prospects", confirmed(rawFields));
  assert.equal(again.status, 200);
  assert.match(again.body, START_FORM);
  assert.deepEqual(fake.started, []);
});

test("Intake UI: Start Research launches the workflow once in the background and redirects to its status", async (t) => {
  const fake = fakeResearch();
  const harness = await startHarness(t, { research: fake.research });

  // Both replies arrive while the workflow is still pending: the request never waits for research.
  const replies = await Promise.all([
    startResearch(harness),
    startResearch(harness),
  ]);
  for (const reply of replies) {
    assert.equal(reply.status, 303);
    assert.equal(reply.headers.location, STATUS_PATH);
    assert.equal(reply.headers["cache-control"], "no-store");
    assert.equal(reply.body, "");
  }
  assert.deepEqual(fake.started, [PROSPECT_ID]);

  const starting = await researchStatus(harness);
  assert.equal(starting.status, 200);
  assert.equal(starting.headers["cache-control"], "no-store");
  assert.ok(
    String(starting.headers["content-security-policy"]).includes(
      "default-src 'none'",
    ),
  );
  assert.ok(starting.body.includes("<h1>Research is running</h1>"));
  assert.ok(starting.body.includes(REFRESH));
  assert.doesNotMatch(starting.body, START_FORM);

  fake.store(summary("researching"));
  const running = await researchStatus(harness);
  assert.ok(running.body.includes("<h1>Research is running</h1>"));
  assert.ok(running.body.includes("<code>researching</code>"));
  assert.ok(running.body.includes(RESEARCH_ID));
  assert.ok(running.body.includes(REFRESH));
  assert.ok(!running.body.includes("not running this research"));
  assert.doesNotMatch(running.body, START_FORM);
  assert.equal((await startResearch(harness)).status, 303);
  assert.deepEqual(fake.started, [PROSPECT_ID]);

  fake.finish(
    summary("research_review", {
      brief_url: "https://docs.google.com/document/d/brief123/edit",
    }),
  );
  const done = await researchStatus(harness);
  assert.ok(done.body.includes("<h1>Research completed</h1>"));
  assert.ok(done.body.includes("<code>research_review</code>"));
  assert.ok(done.body.includes("No Gmail draft was created."));
  assert.ok(
    done.body.includes(
      '<a href="https://docs.google.com/document/d/brief123/edit" rel="noreferrer">',
    ),
  );
  assert.ok(!done.body.includes(REFRESH));
  assert.doesNotMatch(done.body, START_FORM);
  assert.equal((await startResearch(harness)).status, 303);
  assert.deepEqual(fake.started, [PROSPECT_ID]);
  assert.deepEqual(harness.events, [
    { event: "research_requested", prospectId: PROSPECT_ID },
    {
      event: "research_finished",
      prospectId: PROSPECT_ID,
      status: "research_review",
    },
  ]);
});

test("Intake UI: Start Research never starts a prospect that already has research", async (t) => {
  for (const status of [
    "researching",
    "brief_ready",
    "research_review",
    "completed",
    "failed",
    "needs_reconciliation",
  ] as const) {
    const fake = fakeResearch(summary(status));
    const harness = await startHarness(t, { research: fake.research });
    const reply = await startResearch(harness);
    assert.equal(reply.status, 303, status);
    assert.equal(reply.headers.location, STATUS_PATH);
    assert.deepEqual(fake.started, [], status);
    assert.deepEqual(harness.events, [], status);
    assert.doesNotMatch((await researchStatus(harness)).body, START_FORM);
  }
});

test("Intake UI: the research status page reports running, completed, and needs-review states", async (t) => {
  const states = [
    ["researching", "Research is running"],
    ["research_ready", "Research is running"],
    ["folder_creating", "Research is running"],
    ["folder_ready", "Research is running"],
    ["brief_creating", "Research is running"],
    ["brief_ready", "Research is running"],
    ["draft_creating", "Research is running"],
    ["research_review", "Research completed"],
    ["needs_contact", "Research completed"],
    ["completed", "Research completed"],
    ["failed", "Research needs review"],
    ["needs_reconciliation", "Research needs review"],
  ] as const;
  for (const [status, heading] of states) {
    const fake = fakeResearch(summary(status));
    const harness = await startHarness(t, { research: fake.research });
    const reply = await researchStatus(harness);
    assert.equal(reply.status, 200, status);
    assert.ok(reply.body.includes(`<h1>${heading}</h1>`), status);
    assert.ok(reply.body.includes(`<code>${status}</code>`), status);
    assert.ok(reply.body.includes(PROSPECT_ID), status);
    assert.ok(reply.body.includes("2026-11-11T10:00:00.000Z"), status);
    assert.doesNotMatch(reply.body, START_FORM, status);
    // This process did not start the research, so it neither polls nor claims to be running it.
    assert.ok(!reply.body.includes(REFRESH), status);
    assert.equal(
      reply.body.includes("not running this research"),
      heading === "Research is running",
      status,
    );
    assert.deepEqual(fake.started, []);
  }

  const failed = fakeResearch(
    summary("failed", {
      last_error: "Research result validation failed: <b>contact</b>.",
      brief_url: "javascript:alert(1)",
    }),
  );
  const harness = await startHarness(t, { research: failed.research });
  const reply = await researchStatus(harness);
  assert.ok(
    reply.body.includes(
      "Research result validation failed: &lt;b&gt;contact&lt;/b&gt;.",
    ),
  );
  assert.ok(!reply.body.includes("<b>contact</b>"));
  assert.ok(!reply.body.includes("javascript:"));

  const none = await startHarness(t, { research: fakeResearch().research });
  const idle = await researchStatus(none);
  assert.equal(idle.status, 200);
  assert.ok(idle.body.includes("<h1>Research not started</h1>"));
  // Eligibility is unknown here, so the status page never offers the action.
  assert.doesNotMatch(idle.body, START_FORM);
  assert.ok(!idle.body.includes("Start Research"));
  assert.ok(!idle.body.includes(REFRESH));
});

test("Intake UI: the status page hides a stale last_error while research runs or after it completes", async (t) => {
  const stale = "Earlier attempt: provider timed out.";
  for (const status of [
    "researching",
    "brief_ready",
    "research_review",
    "completed",
  ] as const) {
    const fake = fakeResearch(summary(status, { last_error: stale }));
    const harness = await startHarness(t, { research: fake.research });
    const reply = await researchStatus(harness);
    assert.equal(reply.status, 200, status);
    assert.ok(!reply.body.includes(stale), status);
  }
  for (const status of ["failed", "needs_reconciliation"] as const) {
    const fake = fakeResearch(summary(status, { last_error: stale }));
    const harness = await startHarness(t, { research: fake.research });
    assert.ok((await researchStatus(harness)).body.includes(stale), status);
  }
});

test("Intake UI: a start that stops before recording a request is reported without internal details", async (t) => {
  const fake = fakeResearch();
  const harness = await startHarness(t, { research: fake.research });
  assert.equal((await startResearch(harness)).status, 303);
  fake.fail(new Error("FIRECRAWL_API_KEY is required. key=secret-internal"));

  const reply = await researchStatus(harness);
  assert.equal(reply.status, 200);
  assert.ok(reply.body.includes("<h1>Research did not start</h1>"));
  assert.ok(reply.body.includes("recorded no research request"));
  assert.ok(!reply.body.includes("FIRECRAWL_API_KEY"));
  assert.ok(!reply.body.includes("secret-internal"));
  assert.ok(!reply.body.includes(REFRESH));
  assert.deepEqual(harness.events, [
    { event: "research_requested", prospectId: PROSPECT_ID },
    { event: "research_stopped", prospectId: PROSPECT_ID, error: "Error" },
  ]);

  // The status page offers no button, but the start route still rechecks durable state on an explicit POST.
  assert.doesNotMatch(reply.body, START_FORM);
  assert.equal((await startResearch(harness)).status, 303);
  assert.deepEqual(fake.started, [PROSPECT_ID, PROSPECT_ID]);
});

test("Intake UI: research that stops after recording a request needs review and cannot be restarted", async (t) => {
  const fake = fakeResearch();
  const harness = await startHarness(t, { research: fake.research });
  assert.equal((await startResearch(harness)).status, 303);
  fake.store(
    summary("failed", {
      last_error: "Research or provider failed; inspect before new work.",
    }),
  );
  fake.fail(new Error("Research request failed validation or collection."));

  const reply = await researchStatus(harness);
  assert.ok(reply.body.includes("<h1>Research needs review</h1>"));
  assert.ok(
    reply.body.includes(
      "Research or provider failed; inspect before new work.",
    ),
  );
  assert.ok(!reply.body.includes(REFRESH));
  assert.doesNotMatch(reply.body, START_FORM);
  assert.equal((await startResearch(harness)).status, 303);
  assert.deepEqual(fake.started, [PROSPECT_ID]);
});

test("Intake UI: research routes keep the loopback, same-origin, and strict form protections", async (t) => {
  const fake = fakeResearch();
  const harness = await startHarness(t, { research: fake.research });
  const rejected: Record<string, string | undefined>[] = [
    { origin: "https://evil.example" },
    { origin: undefined },
    { origin: "null" },
    { origin: `http://localhost:${harness.port}` },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    {
      host: `evil.example:${harness.port}`,
      origin: `http://evil.example:${harness.port}`,
    },
  ];
  for (const headers of rejected) {
    const reply = await startResearch(harness, undefined, headers);
    assert.equal(reply.status, 403, JSON.stringify(headers));
  }
  const rebound = await send(harness.port, {
    path: STATUS_PATH,
    headers: { host: `evil.example:${harness.port}` },
  });
  assert.equal(rebound.status, 403);

  const json = await startResearch(
    harness,
    JSON.stringify(confirmedResearch(PROSPECT_ID)),
    { "content-type": "application/json" },
  );
  assert.equal(json.status, 415);
  const malformed: (Record<string, string> | string)[] = [
    {},
    { prospectId: PROSPECT_ID },
    { prospectId: PROSPECT_ID, confirm: "create-prospect" },
    confirmedResearch("not-a-prospect"),
    confirmedResearch(`${PROSPECT_ID}0`),
    { ...confirmedResearch(PROSPECT_ID), companyName: "Dev By Taylor" },
    `${new URLSearchParams(confirmedResearch(PROSPECT_ID))}&prospectId=${PROSPECT_ID}`,
  ];
  for (const fields of malformed) {
    const reply = await startResearch(harness, fields);
    assert.equal(reply.status, 400, JSON.stringify(fields));
  }

  for (const [method, path, allow] of [
    ["GET", "/research/start", "POST"],
    ["POST", STATUS_PATH, "GET"],
  ] as const) {
    const reply = await send(harness.port, {
      method,
      path,
      headers: { origin: harness.origin },
    });
    assert.equal(reply.status, 405, `${method} ${path}`);
    assert.equal(reply.headers.allow, allow);
  }
  for (const path of [
    "/research",
    "/research?prospectId=not-a-prospect",
    `/research?prospect=${PROSPECT_ID}`,
  ]) {
    assert.equal((await researchStatus(harness, path)).status, 400, path);
  }
  assert.deepEqual(fake.started, []);
  assert.deepEqual(harness.events, []);

  // Same-origin requests through the localhost name remain usable, and the ID is normalized.
  const local = await startResearch(
    harness,
    confirmedResearch(PROSPECT_ID.toUpperCase()),
    {
      host: `localhost:${harness.port}`,
      origin: `http://localhost:${harness.port}`,
      "sec-fetch-site": undefined,
    },
  );
  assert.equal(local.status, 303);
  assert.equal(local.headers.location, STATUS_PATH);
  assert.deepEqual(fake.started, [PROSPECT_ID]);

  const unconfigured = await startHarness(t);
  assert.equal((await startResearch(unconfigured)).status, 404);
  assert.equal((await researchStatus(unconfigured)).status, 404);
});

test("Intake UI: research is not started when its durable state cannot be read", async (t) => {
  const started: string[] = [];
  const harness = await startHarness(t, {
    research: {
      getRequest: async () => {
        throw new Error(
          "connection failed for private.contact@devbytaylor.com",
        );
      },
      start: async (prospectId) => {
        started.push(prospectId);
        return summary("research_review");
      },
    },
  });
  const start = await startResearch(harness);
  assert.equal(start.status, 500);
  assert.ok(start.body.includes("research was not started"));
  const status = await researchStatus(harness);
  assert.equal(status.status, 500);
  for (const body of [start.body, status.body]) {
    assert.ok(!body.includes("connection failed"));
    assertNoSubmittedInput(body);
  }
  assert.deepEqual(started, []);
  assert.deepEqual(harness.events, [
    { event: "request_failed", error: "Error" },
    { event: "request_failed", error: "Error" },
  ]);
});
