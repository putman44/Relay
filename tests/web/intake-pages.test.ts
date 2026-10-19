import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  escapeHtml,
  INTAKE_PAGE_CSP,
  renderErrorPage,
  renderIntakeForm,
  renderIntakeOutcomeUnknown,
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
  assert.ok(html.includes('autocomplete="off">\n\nStarts with a newline</textarea>'));
});
