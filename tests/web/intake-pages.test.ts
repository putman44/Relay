import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  escapeHtml,
  INTAKE_PAGE_CSP,
  renderErrorPage,
  renderIntakeForm,
  renderIntakeOutcomeUnknown,
  renderIntakeSuccess,
  renderResearchStatus,
} from "../../src/web/intake-pages.js";

test("Intake pages: escapeHtml neutralizes markup and attribute delimiters", () => {
  assert.equal(
    escapeHtml(`<a href="x" title='y'>&amp;</a>`),
    "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;",
  );
});

test("Intake pages: the CSP allows exactly the inline stylesheet and no scripts", () => {
  assert.ok(!INTAKE_PAGE_CSP.includes("unsafe"));
  assert.ok(!INTAKE_PAGE_CSP.includes("script-src"));
  for (const html of [
    renderIntakeForm({ requestId: "id" }),
    renderErrorPage("Title", "Message"),
    renderIntakeOutcomeUnknown("id"),
    renderIntakeSuccess(
      {
        requestId: "id",
        prospectId: "prospect",
        stage: "researching",
        created: true,
      },
      "id",
      "start",
    ),
    renderResearchStatus({
      prospectId: "prospect",
      request: null,
      local: "running",
    }),
    renderResearchStatus({
      prospectId: "prospect",
      request: null,
      local: "stopped",
    }),
  ]) {
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
    assert.ok(style !== undefined);
    const hash = createHash("sha256").update(style).digest("base64");
    assert.ok(INTAKE_PAGE_CSP.includes(`style-src 'sha256-${hash}'`));
    assert.ok(!/<script|\son\w+=/i.test(html));
  }
});

test("Intake pages: textarea values survive HTML parsing unchanged", () => {
  const html = renderIntakeForm({
    requestId: "id",
    values: { primaryDiscoveryQuestion: "\nStarts with a newline" },
  });
  assert.ok(
    html.includes('autocomplete="off">\n\nStarts with a newline</textarea>'),
  );
});

const RESEARCH_STATUSES = [
  "researching",
  "research_ready",
  "folder_creating",
  "folder_ready",
  "brief_creating",
  "brief_ready",
  "draft_creating",
  "research_review",
  "needs_contact",
  "completed",
  "failed",
  "needs_reconciliation",
] as const;

test("Intake pages: a recorded research error is shown only for failed and needs_reconciliation", () => {
  const lastError = "Earlier attempt: provider timed out.";
  for (const status of RESEARCH_STATUSES) {
    const html = renderResearchStatus({
      prospectId: "prospect",
      request: {
        id: "request",
        status,
        updated_at: new Date("2026-11-11T10:00:00.000Z"),
        last_error: lastError,
        brief_url: null,
      },
      local: "idle",
    });
    assert.equal(
      html.includes(lastError),
      status === "failed" || status === "needs_reconciliation",
      status,
    );
  }
});

test("Intake pages: the research status page never offers Start Research, but the success page does", () => {
  const offered = renderIntakeSuccess(
    {
      requestId: "id",
      prospectId: "prospect",
      stage: "researching",
      created: true,
    },
    "id",
    "start",
  );
  assert.ok(offered.includes('action="/research/start"'));
  assert.ok(offered.includes("Start Research"));

  const views = [
    { request: null, local: "idle" },
    { request: null, local: "running" },
    { request: null, local: "stopped" },
    ...RESEARCH_STATUSES.map((status) => ({
      request: {
        id: "request",
        status,
        updated_at: new Date("2026-11-11T10:00:00.000Z"),
        last_error: null,
        brief_url: null,
      },
      local: "idle" as const,
    })),
  ] as const;
  for (const view of views) {
    const html = renderResearchStatus({ prospectId: "prospect", ...view });
    assert.ok(!html.includes("/research/start"), JSON.stringify(view));
    assert.ok(!html.includes("Start Research"), JSON.stringify(view));
    assert.ok(!html.includes("<form"), JSON.stringify(view));
  }
});
