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
import {
  MAX_INTAKE_FORM_BYTES,
  parseIntakeUiPort,
  startIntakeServer,
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
