import { createHash } from "node:crypto";
import type { IndexedProspect } from "../data/research-embeddings.js";
import type { AskRelayResult } from "../research/ask-relay.js";
import { escapeHtml, INTAKE_STYLE } from "./intake-pages.js";

export const ASK_PATH = "/ask";
export const ANSWER_PATH = "/answer";
export const ASK_ID_FIELD = "askId";
export const ASK_PROSPECT_FIELD = "prospectId";
export const ASK_QUESTION_FIELD = "question";
export const ASK_CONFIRM_FIELD = "confirm";
export const ASK_CONFIRM_VALUE = "ask-relay";
export const MAX_QUESTION_CHARS = 500;
export const answerPath = (askId: string) =>
  `${ANSWER_PATH}?id=${encodeURIComponent(askId)}`;

// The intake stylesheet plus the few elements these pages add.
const STYLE = `${INTAKE_STYLE}
h2{margin:0 0 .5rem;font-size:1.15rem;line-height:1.3}
select{width:100%;padding:.55rem .65rem;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:.35rem}
select:focus,summary:focus{outline:2px solid var(--accent);outline-offset:2px}
.hint{margin:.35rem 0 0;color:var(--muted);font-size:.85rem}
.answer{margin:.25rem 0 0;font-size:1.05rem;white-space:pre-wrap;overflow-wrap:anywhere}
.sources{margin:0;padding:0;list-style:none}
.sources li{padding:.75rem 0;border-bottom:1px solid var(--line)}
.sources li:first-child{padding-top:0}
.sources li:last-child{padding-bottom:0;border-bottom:0}
.source{margin:0;overflow-wrap:anywhere}
.source-id{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem}
blockquote{margin:.5rem 0 0;padding:.1rem 0 .1rem .8rem;border-left:3px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere}
summary{cursor:pointer;font-weight:600}
.retrieved{margin:.75rem 0 0;color:var(--muted);font-size:.9rem;overflow-wrap:anywhere}
`;

// Only this exact inline stylesheet is permitted: no scripts, frames, or external loads.
export const ASK_PAGE_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${createHash("sha256").update(STYLE).digest("base64")}'`,
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

export type AskFormView = {
  askId: string;
  prospects: readonly IndexedProspect[];
  selected?: string;
  question?: string;
  error?: string;
};
export type AskSummary = { prospect: IndexedProspect; question: string };

function page(title: string, content: string, head = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${head}
<title>${escapeHtml(title)} · Ask Relay</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="eyebrow">Relay · Ask Relay demo</p>
${content}
</main>
</body>
</html>
`;
}

const prospectLabel = (prospect: IndexedProspect) =>
  `${prospect.companyName} (${prospect.embeddedChunks} chunks)`;

// Source URLs come from stored research; only https URLs become links.
function sourceLink(url: string): string {
  let https = false;
  try {
    https = new URL(url).protocol === "https:";
  } catch {
    /* Shown as text below. */
  }
  return https
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>`
    : escapeHtml(url);
}

function askForm(view: AskFormView, heading: string): string {
  if (!view.prospects.length)
    return `<div class="notice warning" role="status">
<p><strong>No prospect has embedded research yet.</strong></p>
<p>Index the demo research first: <code>scripts/ask-relay-demo.sh index --confirm-embeddings</code></p>
</div>`;
  const options = view.prospects
    .map(
      (prospect) =>
        `<option value="${escapeHtml(prospect.id)}"${prospect.id === view.selected ? " selected" : ""}>${escapeHtml(prospectLabel(prospect))}</option>`,
    )
    .join("\n");
  const error =
    view.error === undefined
      ? ""
      : `<div class="notice error" role="alert"><p>${escapeHtml(view.error)}</p></div>`;
  // The newline after <textarea> is dropped by HTML parsing, so the value survives unchanged.
  return `${error}
<form class="panel" method="post" action="${ASK_PATH}" accept-charset="UTF-8" autocomplete="off">
<h2>${escapeHtml(heading)}</h2>
<input type="hidden" name="${ASK_ID_FIELD}" value="${escapeHtml(view.askId)}">
<div class="field"><label for="field-prospect">Prospect</label>
<select id="field-prospect" name="${ASK_PROSPECT_FIELD}" required>
${options}
</select></div>
<div class="field"><label for="field-question">Question</label>
<textarea id="field-question" name="${ASK_QUESTION_FIELD}" rows="3" maxlength="${MAX_QUESTION_CHARS}" required aria-describedby="question-hint">
${escapeHtml(view.question ?? "")}</textarea>
<p class="hint" id="question-hint">Relay answers only from this prospect's saved website research. Each question calls OpenAI.</p></div>
<div class="actions"><button type="submit" name="${ASK_CONFIRM_FIELD}" value="${ASK_CONFIRM_VALUE}">Ask Relay</button></div>
</form>`;
}

function questionSummary(summary: AskSummary): string {
  return `<div class="panel"><dl>
<div><dt>Prospect</dt><dd>${escapeHtml(summary.prospect.companyName)}</dd></div>
<div><dt>Question</dt><dd>${escapeHtml(summary.question)}</dd></div>
</dl></div>`;
}

export function renderAskForm(view: AskFormView): string {
  return page(
    "Ask a question",
    `<h1>Ask Relay</h1>
<p>Ask a question about one prospect. Relay searches only that prospect's saved website research and answers with verified quotes, or says the evidence is not there.</p>
${askForm(view, "Ask a question")}`,
  );
}

// Pages carry no scripts, so a pending answer reloads itself until it is ready.
export function renderAskPending(summary: AskSummary, askId: string): string {
  return page(
    "Searching",
    `<h1>Ask Relay</h1>
<div class="notice warning" role="status" aria-live="polite">
<p><strong>Searching this prospect's research…</strong></p>
<p>Relay is finding the most similar chunks and drafting an answer from them. This page updates automatically.</p>
</div>
${questionSummary(summary)}
<p class="meta"><a href="${escapeHtml(answerPath(askId))}">Reload</a></p>`,
    '\n<meta http-equiv="refresh" content="1">',
  );
}

const INSUFFICIENT_NOTES: Record<
  Exclude<AskRelayResult["reason"], null>,
  string
> = {
  model_reported:
    "The retrieved research does not answer this question. Relay did not guess or use outside knowledge.",
  unverified_citations:
    "The drafted answer was withheld because its quotes did not match the retrieved research.",
  no_indexed_research: "This prospect has no embedded research to search.",
};

function sourcesPanel(result: AskRelayResult): string {
  const groups = new Map<string, { url: string; quotes: string[] }>();
  for (const citation of result.citations) {
    const group = groups.get(citation.sourceId) ?? {
      url: citation.sourceUrl,
      quotes: [],
    };
    group.quotes.push(citation.quote);
    groups.set(citation.sourceId, group);
  }
  const items = [...groups]
    .map(
      ([id, group]) =>
        `<li><p class="source"><span class="source-id">[${escapeHtml(id)}]</span> ${sourceLink(group.url)}</p>
${group.quotes.map((quote) => `<blockquote>${escapeHtml(quote)}</blockquote>`).join("\n")}</li>`,
    )
    .join("\n");
  return `<section class="panel" aria-labelledby="sources-heading">
<h2 id="sources-heading">Sources and verified quotes</h2>
<p class="hint">Each quote was checked word for word against the retrieved research before this answer was shown.</p>
<ol class="sources">
${items}
</ol>
</section>`;
}

function retrievedPanel(result: AskRelayResult): string {
  if (!result.retrieved.length) return "";
  const rows = result.retrieved
    .map(
      (chunk) =>
        `<li><span class="source-id">[${escapeHtml(chunk.sourceId)}]</span> ${escapeHtml(chunk.similarity.toFixed(3))} · ${escapeHtml(chunk.sourceUrl)}</li>`,
    )
    .join("\n");
  return `<details class="panel">
<summary>Retrieved by vector similarity: ${result.retrieved.length} chunks</summary>
<ol class="retrieved">
${rows}
</ol>
</details>`;
}

export function renderAskAnswer(
  summary: AskSummary,
  result: AskRelayResult,
  next: AskFormView,
): string {
  const outcome =
    result.status === "answered"
      ? `<div class="notice success" role="status">
<h2>Answer</h2>
<p class="answer">${escapeHtml(result.answer)}</p>
</div>
${sourcesPanel(result)}`
      : `<div class="notice warning" role="status">
<h2>Not enough evidence</h2>
<p class="answer">${escapeHtml(result.answer)}</p>
<p>${escapeHtml(INSUFFICIENT_NOTES[result.reason ?? "model_reported"])}</p>
</div>`;
  return page(
    result.status === "answered" ? "Answer" : "Not enough evidence",
    `<h1>Ask Relay</h1>
${questionSummary(summary)}
${outcome}
${retrievedPanel(result)}
${askForm(next, "Ask another question")}`,
  );
}

// Fixed text only: never provider or database error details.
export function renderAskFailed(summary: AskSummary, next: AskFormView): string {
  return page(
    "No answer",
    `<h1>Ask Relay</h1>
${questionSummary(summary)}
<div class="notice error" role="alert">
<p><strong>Relay could not answer this question.</strong></p>
<p>Something went wrong while searching or drafting. Nothing was saved, and the question can be asked again.</p>
</div>
${askForm(next, "Ask again")}`,
  );
}

export function renderAskErrorPage(title: string, message: string): string {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1>
<div class="notice error" role="alert"><p>${escapeHtml(message)}</p></div>
<p class="meta"><a href="/">Ask a question</a></p>`,
  );
}
