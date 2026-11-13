import { strict as assert } from "node:assert";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { startIntakeServer } from "../../src/web/intake-server.js";
import { createAskRelayHandler } from "../../src/web/ask-relay-server.js";
import { DASHBOARD_CSP, renderDashboard } from "../../src/web/prospect-dashboard.js";
import type { DashboardProspect } from "../../src/data/research-embeddings.js";

const FIRST = "00000000-0000-4000-a000-000000000001";
const SECOND = "00000000-0000-4000-a000-000000000002";
const REQUEST = "11111111-1111-4111-8111-111111111111";
const prospects: DashboardProspect[] = [
  { id: FIRST, companyName: "First & Co", website: "https://first.example/", industry: "Services", contactName: "Pat", contactEmail: null, stage: "researching", embeddedChunks: 2 },
  { id: SECOND, companyName: "Second Co", website: null, industry: null, contactName: null, contactEmail: null, stage: "researching", embeddedChunks: 0 },
];

test("dashboard lists and selects prospects, gates missing research, and scopes Ask Relay", async (t) => {
  const asks: string[] = [];
  const server = await startIntakeServer({
    port: 0,
    generateRequestId: () => REQUEST,
    createProspect: async (input) => ({ requestId: input.requestId, prospectId: SECOND, stage: "researching", created: true }),
    dashboard: {
      listProspects: async () => prospects,
      render: renderDashboard,
      csp: DASHBOARD_CSP,
      askHandler: (getServer) => createAskRelayHandler({
        listProspects: async () => prospects.filter((p) => p.embeddedChunks),
        ask: async ({ prospectId, question }) => {
          asks.push(prospectId);
          return { question, status: "insufficient_evidence", reason: "model_reported", answer: "Not enough evidence", citations: [], retrieved: [] };
        },
      }, getServer),
    },
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  async function send(path: string, body?: string, hostile = false) {
    return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { origin: hostile ? "https://evil.example" : origin, "content-type": "application/x-www-form-urlencoded" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }
  const home = await send("/");
  assert.equal(home.status, 200);
  assert.match(home.body, /First &amp; Co/);
  assert.match(home.body, /Second Co/);
  assert.match(home.body, /Research not indexed/);
  assert.match(String(home.headers["content-security-policy"]), /^default-src 'none'; style-src 'sha256-/);
  const first = await send(`/prospect?id=${FIRST}`);
  assert.match(first.body, /name="prospectId" required/);
  assert.doesNotMatch(first.body, new RegExp(`<option value="${SECOND}"`));
  const second = await send(`/prospect?id=${SECOND}`);
  assert.match(second.body, /Ask Relay is unavailable/);
  assert.doesNotMatch(second.body, /method="post" action="\/ask"/);
  assert.equal((await send("/prospect?id=bad")).status, 400);
  assert.equal((await send(`/ask`, new URLSearchParams({ askId: REQUEST, prospectId: SECOND, question: "Question?", confirm: "ask-relay" }).toString())).status, 422);
  assert.equal(asks.length, 0);
  assert.equal((await send(`/ask`, new URLSearchParams({ askId: REQUEST, prospectId: FIRST, question: "Question?", confirm: "ask-relay" }).toString(), true)).status, 403);
  assert.equal(asks.length, 0);
  const ask = await send(`/ask`, new URLSearchParams({ askId: REQUEST, prospectId: FIRST, question: "Question?", confirm: "ask-relay" }).toString());
  assert.equal(ask.status, 303);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asks, [FIRST]);
  const answer = await send(String(ask.headers.location));
  assert.match(answer.body, /Not enough evidence/);
  assert.match(answer.body, /First &amp; Co/);
});

test("creating a prospect redirects to its detail without starting research", async (t) => {
  let created = 0;
  const server = await startIntakeServer({
    port: 0, generateRequestId: () => REQUEST,
    createProspect: async (input) => { created++; return { requestId: input.requestId, prospectId: SECOND, stage: "researching", created: true }; },
    dashboard: { listProspects: async () => prospects, render: renderDashboard, csp: DASHBOARD_CSP, askHandler: (getServer) => createAskRelayHandler({ listProspects: async () => [], ask: async () => { throw new Error("unexpected"); } }, getServer) },
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const fields = new URLSearchParams({ requestId: REQUEST, companyName: "Second Co", website: "", industry: "", contactName: "", contactEmail: "", primaryDiscoveryQuestion: "" });
  async function post(path: string, body: string) {
    return new Promise<{ status: number; location: string | undefined; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, location: res.headers.location, body: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject); req.end(body);
    });
  }
  assert.match((await post("/review", fields.toString())).body, /Confirm and create prospect/);
  fields.set("confirm", "create-prospect");
  const saved = await post("/prospects", fields.toString());
  assert.equal(saved.status, 303);
  assert.equal(saved.location, `/prospect?id=${SECOND}&saved=created`);
  assert.equal(created, 1);
});
