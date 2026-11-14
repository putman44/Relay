import {
  MAX_ASSESSMENT_ATTEMPTS,
  type AssessmentHistory,
  type AssessmentRecord,
} from "../data/lead-assessments.js";
import type {
  AssessmentResult,
  Hypothesis,
  VerifiedCitation,
} from "../research/lead-intake-assessment.js";
import { readableQuote } from "../research/intake-evidence.js";
import { sourceLink } from "./ask-relay-pages.js";
import { escapeHtml } from "./intake-pages.js";

export const ASSESSMENT_PATH = "/assessment";
export const ASSESSMENT_CONFIRM_VALUE = "generate-assessment";

export const ASSESSMENT_STYLE = `
.assessment-body h3{margin:1.25rem 0 .35rem;font-size:1rem}
.assessment-body h4{margin:.75rem 0 .25rem;font-size:.85rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.assessment-body ul,.assessment-body ol{margin:.25rem 0 0;padding-left:1.25rem}
.assessment-body li{margin:.25rem 0;overflow-wrap:anywhere}
.assessment-body .category{margin-top:.75rem;padding-top:.75rem;border-top:1px solid var(--line)}
.assessment-body .category>summary{font-size:1rem}
.status-line{display:flex;flex-wrap:wrap;gap:.25rem 1rem;color:var(--muted);font-size:.9rem}
.grade{display:inline-block;min-width:2rem;padding:.05rem .5rem;margin-right:.4rem;border:1px solid var(--line);border-radius:.35rem;font-weight:700;text-align:center}
.tag{color:var(--muted);font-size:.8rem;font-weight:600}
.intelligence{margin-top:1rem;border-color:var(--accent)}
.intelligence h3{margin:.9rem 0 .3rem;font-size:.85rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.intelligence p{margin:.3rem 0;line-height:1.5}
.intelligence ol{margin:.35rem 0;padding-left:1.3rem}
.intelligence li{margin:.25rem 0}
.intelligence .status-line{margin-top:.8rem}
.assessment-body blockquote{max-width:68ch;line-height:1.55;color:var(--text);background:rgba(255,255,255,.025);padding:.45rem .7rem}
`;

type StatusView = { label: string; tone: "ok" | "warning" | "error" | "plain" };

function statusView(history: AssessmentHistory): StatusView {
  const latest = history.records[0];
  if (!latest) return { label: "Not generated", tone: "plain" };
  if (latest.status === "generating") return { label: "Generating", tone: "warning" };
  if (latest.status === "needs_review") return { label: "Needs review", tone: "error" };
  if (latest.status === "failed") return { label: "Failed", tone: "error" };
  return latest.outdated
    ? { label: "Outdated", tone: "warning" }
    : { label: "Current", tone: "ok" };
}

export function assessmentGenerating(history: AssessmentHistory | null): boolean {
  return history?.records[0]?.status === "generating";
}

function date(value: Date): string {
  return value.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function citations(items: readonly VerifiedCitation[]): string {
  return `<ul class="sources">${items
    .map(
      (item) =>
        `<li><span class="source-id">[${escapeHtml(item.sourceId)}]</span> ${sourceLink(item.sourceUrl)}<blockquote>${escapeHtml(readableQuote(item.quote))}</blockquote></li>`,
    )
    .join("")}</ul>`;
}

function bullets(items: readonly string[]): string {
  return items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "";
}

// Stored results are written only by the server, but a malformed row is
// shown as unavailable rather than rendered.
function isResult(value: unknown): value is AssessmentResult {
  const result = value as Partial<AssessmentResult> | null;
  return (
    !!result &&
    result.schemaVersion === 3 &&
    Array.isArray(result.unconfirmed) &&
    Array.isArray(result.sources) &&
    Array.isArray(result.categories) &&
    Array.isArray(result.topOpportunities) &&
    !!result.fit &&
    Array.isArray(result.fit.signals) &&
    Array.isArray(result.fit.unknowns)
  );
}

function hypothesisBlock(item: Hypothesis): string {
  return `<p><span class="tag">Observed (verified)</span> ${escapeHtml(item.observed.statement)}</p>${citations(item.observed.citations)}
<p><span class="tag">Unknown</span> ${escapeHtml(item.unknown.text)}</p>
<p><span class="tag">Hypothesis, not verified</span> ${escapeHtml(item.statement)}</p>`;
}

function renderResult(result: AssessmentResult): string {
  const fit = result.fit;
  return `<h3>Preliminary prospect fit</h3>
<p><span class="grade">${escapeHtml(fit.grade)}</span>${escapeHtml(fit.rationale)}</p>
<p class="hint">A preliminary discovery-priority classification under rubric ${escapeHtml(fit.rubricVersion)}. It is not a diagnosis of the business's operations, and it is provisional until discovery.</p>
${
  fit.signals.length
    ? `<h4>Verified signals behind the grade</h4><ul>${fit.signals
        .map(
          (item) =>
            `<li><span class="tag">${escapeHtml(item.kind === "complexity" ? "Complexity signal" : "Limited-relevance signal")}</span> <strong>${escapeHtml(item.label)}</strong>: ${escapeHtml(item.statement)}${citations(item.citations)}</li>`,
        )
        .join("")}</ul>`
    : ""
}
${fit.unknowns.length ? `<h4>Still unclear</h4>${bullets(fit.unknowns.map((item) => item.text))}` : ""}
<h3>Business intake summary</h3>
<p class="hint">Composed by Relay from the verified observations below. It adds no model-written claims.</p>
${
  result.summary
    ? `<p>${escapeHtml(result.summary.statement)}</p>${citations(result.summary.citations)}`
    : '<p class="hint">No observation could be verified from the retrieved excerpts, so there is no summary.</p>'
}
<h3>Primary opportunity hypothesis</h3>
${
  result.primaryOpportunityHypothesis
    ? hypothesisBlock(result.primaryOpportunityHypothesis)
    : '<p class="hint">The drafted hypothesis was withheld because it was not grounded in a verified observation or was worded as a conclusion.</p>'
}
<h3>Primary discovery question</h3>
${
  result.primaryDiscoveryQuestion
    ? `<p>${escapeHtml(result.primaryDiscoveryQuestion)}</p>`
    : '<p class="hint">The drafted question was withheld because it did not meet the discovery question standard.</p>'
}
<h3>Top opportunities to investigate</h3>
${
  result.topOpportunities.length
    ? `<ol>${result.topOpportunities
        .map(
          (item) =>
            `<li><strong>${escapeHtml(item.title)}</strong>${hypothesisBlock(item)}</li>`,
        )
        .join("")}</ol>`
    : '<p class="hint">No opportunity met the evidence and hypothesis standards.</p>'
}
${
  result.unconfirmed.length
    ? `<h3>Unconfirmed</h3><p class="hint">These quotes relate to a claim but do not plainly show it, or they hedge it. They were not counted and do not affect the grade.</p><ul>${result.unconfirmed
        .map(
          (item) =>
            `<li><span class="tag">Unconfirmed</span> <strong>${escapeHtml(item.label)}</strong>${citations(item.citations)}</li>`,
        )
        .join("")}</ul>`
    : ""
}
<h3>Evidence by category</h3>
${result.categories
    .map(
      (category) =>
        `<details class="category"><summary>${escapeHtml(category.label)}</summary>
<h4>Verified observations</h4>
${
  category.observations.length
    ? `<ul>${category.observations
        .map(
          (item) =>
            `<li>${escapeHtml(item.statement)}${citations(item.citations)}</li>`,
        )
        .join("")}</ul>`
    : '<p class="hint">No verified observations from the retrieved excerpts.</p>'
}
<h4>Unknown</h4>
${bullets(category.unknowns.map((item) => item.text)) || '<p class="hint">No additional unknowns recorded in this category.</p>'}
<h4>Possible Relay opportunities (hypotheses)</h4>
${bullets(category.hypotheses) || '<p class="hint">No grounded opportunity hypothesis in this category.</p>'}
<h4>Discovery questions</h4>
${bullets(category.discoveryQuestions) || '<p class="hint">No category-specific discovery question recorded.</p>'}
</details>`,
    )
    .join("\n")}
${result.sources.some((item) => item.flagged) ? '<p class="hint">A source excerpt contained instruction-like text. It was treated as evidence only; it was never followed or accepted as a quote.</p>' : ""}
${result.withheld ? `<p class="hint">${result.withheld} model output${result.withheld === 1 ? " was" : "s were"} withheld because the quote did not support the claim, the text was not allowed, or it did not meet the evidence standards.</p>` : ""}`;
}

const UNDISPLAYABLE = '<p class="hint">The stored assessment could not be displayed.</p>';

// A stored row of an unexpected inner shape must not take the whole page down.
function safeRender(result: AssessmentResult): string {
  try {
    return renderResult(result);
  } catch {
    return UNDISPLAYABLE;
  }
}

function generateAction(
  prospectId: string,
  history: AssessmentHistory,
  eligible: boolean,
): string {
  const current = history.current;
  if (!eligible || !current)
    return '<p class="hint">Assessments are available after this prospect has indexed website research.</p>';
  const forThisResearch = history.records.filter(
    (record) => record.evidenceFingerprint === current.fingerprint,
  );
  const blocking = forThisResearch.find((record) => record.status !== "failed");
  if (blocking?.status === "completed")
    return '<p class="hint">This assessment matches the current research.</p>';
  if (blocking?.status === "generating")
    return '<p class="hint">An assessment is running. This page updates automatically.</p>';
  if (blocking?.status === "needs_review")
    return '<p class="hint">The last run for this research needs review before another paid run. Nothing was retried.</p>';
  if (forThisResearch.length >= MAX_ASSESSMENT_ATTEMPTS)
    return '<p class="hint">Attempts for this research reached the limit. Review before another paid run.</p>';
  const regenerate = history.records.some((record) => record.outdated);
  return `<form method="post" action="${ASSESSMENT_PATH}" accept-charset="UTF-8">
<input type="hidden" name="prospectId" value="${escapeHtml(prospectId)}">
<p class="hint">Confirm one OpenAI assessment request over this prospect's saved research. Firecrawl will not run.</p>
<div class="actions"><button type="submit" name="confirm" value="${ASSESSMENT_CONFIRM_VALUE}">${regenerate ? "Regenerate Assessment" : "Generate Assessment"}</button></div>
</form>`;
}

function historyList(records: readonly AssessmentRecord[]): string {
  if (records.length < 2) return "";
  return `<details class="category"><summary>Assessment history: ${records.length}</summary><ul>${records
    .map(
      (record) =>
        `<li>${escapeHtml(date(record.createdAt))} · ${escapeHtml(
          record.status === "completed" && record.outdated ? "completed (outdated)" : record.status.replace("_", " "),
        )}</li>`,
    )
    .join("")}</ul></details>`;
}

export function renderAssessmentSection(
  prospect: { id: string; embeddedChunks: number; websiteIndexStatus?: string | null },
  history: AssessmentHistory | null,
): string {
  const indexed =
    prospect.embeddedChunks > 0 &&
    (!prospect.websiteIndexStatus || prospect.websiteIndexStatus === "ready");
  const view = history ?? { current: null, records: [] };
  const status = statusView(view);
  const shown = view.records.find((record) => record.status === "completed");
  const result = shown && isResult(shown.result) ? shown.result : null;
  const outdated = shown?.outdated
    ? '<div class="notice warning" role="status"><p>The research or the fit rubric has changed since this assessment was generated. It is kept as history; generate a new one to analyze the current basis.</p></div>'
    : "";
  const held =
    view.records[0]?.status === "needs_review" || view.records[0]?.status === "failed"
      ? `<div class="notice error" role="status"><p>${
          view.records[0].status === "failed"
            ? "The last assessment response was unusable, so nothing was saved from it."
            : "The last assessment run did not finish cleanly. It was held for review and was not retried."
        }</p></div>`
      : "";
  return `<details class="panel assessment"><summary>${result ? "Detailed Assessment" : "Lead Intake Assessment"}</summary>
<div class="assessment-body">
<p class="status-line"><span>Status: <strong>${escapeHtml(status.label)}</strong></span>${shown ? `<span>Generated ${escapeHtml(date(shown.createdAt))}</span>` : ""}</p>
<p class="hint">Built only from this prospect's saved website research. Verified observations carry exact quotes; what the website does not say is listed as unknown, never as a shortcoming. Opportunities are hypotheses to test in discovery.</p>
${outdated}${held}${generateAction(prospect.id, view, indexed)}
${shown && !result ? UNDISPLAYABLE : ""}${result ? safeRender(result) : ""}
${historyList(view.records)}
</div></details>`;
}

export function renderIntelligenceOverview(
  companyName: string,
  history: AssessmentHistory | null,
): string {
  const view = history ?? { current: null, records: [] };
  const shown = view.records.find((record) => record.status === "completed");
  if (!shown || !isResult(shown.result)) return "";
  try {
    const result = shown.result;
    const opportunities = result.topOpportunities.length
      ? `<h3>Opportunities to investigate</h3><ol>${result.topOpportunities.map((item) => `<li>${escapeHtml(item.title)}</li>`).join("")}</ol>`
      : "";
    return `<section class="panel intelligence" aria-label="Prospect intelligence overview">
<h2>Prospect intelligence</h2>
<p><strong>${escapeHtml(companyName)}</strong> · Preliminary fit <span class="grade">${escapeHtml(result.fit.grade)}</span></p>
<p class="status-line"><span>Assessment: <strong>${escapeHtml(statusView(view).label)}</strong></span><span>Generated ${escapeHtml(date(shown.createdAt))}</span></p>
<h3>Business intake</h3><p>${result.summary ? escapeHtml(result.summary.statement) : "No business summary could be verified from the saved excerpts."}</p>
${opportunities}
${result.primaryDiscoveryQuestion ? `<h3>Start discovery with</h3><p>${escapeHtml(result.primaryDiscoveryQuestion)}</p>` : ""}
<p class="hint">Based on saved website evidence. Opportunities are hypotheses; open Detailed Assessment for sources, unknowns, and fit rationale.</p>
</section>`;
  } catch {
    return "";
  }
}
