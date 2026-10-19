import { createHash } from 'node:crypto';
import type { ProspectIntakeInput, ProspectIntakeResult } from '../intake/prospect-intake.js';

export type IntakeField = keyof ProspectIntakeInput;
export type IntakeFormValues = Partial<Record<IntakeField, string>>;
type ProspectField = Exclude<IntakeField, 'requestId'>;

// Labels only: prospect intake owns every validation rule, so the form adds no client-side constraints.
const FIELDS: Record<ProspectField, { label: string; required?: true; multiline?: true; inputMode?: 'url' | 'email' }> = {
  companyName: { label: 'Company name', required: true },
  website: { label: 'Website', required: true, inputMode: 'url' },
  industry: { label: 'Industry' },
  contactName: { label: 'Contact name' },
  contactEmail: { label: 'Contact email', inputMode: 'email' },
  primaryDiscoveryQuestion: { label: 'Primary discovery question', multiline: true },
};
const PROSPECT_FIELDS = Object.keys(FIELDS) as ProspectField[];
export const INTAKE_FIELDS: readonly IntakeField[] = ['requestId', ...PROSPECT_FIELDS];
export const INTAKE_CONFIRM_FIELD = 'confirm';
export const INTAKE_CONFIRM_VALUE = 'create-prospect';

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--panel:#fff;--text:#1d2330;--muted:#5b6475;--line:#d8dce3;--accent:#1f5eff;--on-accent:#fff;--error-bg:#fdecec;--error-line:#e3a5a5;--warn-bg:#fff6e0;--warn-line:#e5c77a;--ok-bg:#e9f7ef;--ok-line:#9fd3b3}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--panel:#1c2027;--text:#e6e9ef;--muted:#9aa3b2;--line:#323844;--accent:#6b93ff;--on-accent:#0b0d10;--error-bg:#3a1f22;--error-line:#7a3b40;--warn-bg:#3a3020;--warn-line:#7a6234;--ok-bg:#1d3326;--ok-line:#3f7356}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:40rem;margin:0 auto;padding:2rem 1rem 3rem}
.eyebrow{margin:0 0 .25rem;color:var(--muted);font-size:.8rem;letter-spacing:.06em;text-transform:uppercase}
h1{margin:0 0 .5rem;font-size:1.6rem;line-height:1.2}
.panel{margin-top:1.5rem;padding:1.25rem;background:var(--panel);border:1px solid var(--line);border-radius:.5rem}
.panel>p:first-child{margin-top:0}
.field{margin-bottom:1rem}
label{display:block;margin-bottom:.3rem;font-weight:600}
.required{color:var(--muted);font-weight:400;font-size:.85rem}
input,textarea{width:100%;padding:.55rem .65rem;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:.35rem}
textarea{resize:vertical}
input:focus,textarea:focus,button:focus,a:focus{outline:2px solid var(--accent);outline-offset:2px}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.25rem}
button{padding:.6rem 1.1rem;font:inherit;font-weight:600;color:var(--on-accent);background:var(--accent);border:1px solid var(--accent);border-radius:.35rem;cursor:pointer}
button.secondary{color:var(--text);background:transparent;border-color:var(--line)}
dl{margin:0}
dl div{padding:.6rem 0;border-bottom:1px solid var(--line)}
dl div:last-child{border-bottom:0}
dt{color:var(--muted);font-size:.85rem}
dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.empty{color:var(--muted);font-style:italic}
.notice{margin-top:1.25rem;padding:.9rem 1rem;border:1px solid;border-radius:.5rem}
.notice p{margin:.25rem 0}
.error{background:var(--error-bg);border-color:var(--error-line)}
.warning{background:var(--warn-bg);border-color:var(--warn-line)}
.success{background:var(--ok-bg);border-color:var(--ok-line)}
ol{padding-left:1.25rem}
.meta{margin-top:1.5rem;color:var(--muted);font-size:.85rem}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;overflow-wrap:anywhere}
a{color:var(--accent)}
`;

// The policy permits only this exact inline stylesheet: no scripts, frames, or external loads.
export const INTAKE_PAGE_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${createHash('sha256').update(STYLE).digest('base64')}'`,
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ENTITIES[character]!);
}

function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Relay intake</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="eyebrow">Relay · internal operator intake</p>
${content}
</main>
</body>
</html>
`;
}

const hiddenField = (name: string, value: string) =>
  `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
const requestIdMeta = (requestId: string) =>
  `<p class="meta">Intake request ID <code>${escapeHtml(requestId)}</code></p>`;
const startOver = '<p class="meta"><a href="/">Start a new intake</a></p>';

function formField(name: ProspectField, value: string): string {
  const { label, required, multiline, inputMode } = FIELDS[name];
  const id = `field-${name}`;
  const marker = required ? ' <span class="required">required</span>' : '';
  // The newline after <textarea> is dropped by HTML parsing, so the value survives unchanged.
  const control = multiline
    ? `<textarea id="${id}" name="${name}" rows="4" autocomplete="off">\n${escapeHtml(value)}</textarea>`
    : `<input type="text" id="${id}" name="${name}"${inputMode ? ` inputmode="${inputMode}"` : ''} autocomplete="off" value="${escapeHtml(value)}">`;
  return `<div class="field"><label for="${id}">${escapeHtml(label)}${marker}</label>${control}</div>`;
}

export function renderIntakeForm(options: { requestId: string; values?: IntakeFormValues; error?: string }): string {
  const values = options.values ?? {};
  const error = options.error === undefined ? '' : `<div class="notice error" role="alert">
<p><strong>Relay did not accept this input.</strong></p>
<p>${escapeHtml(options.error)}</p>
</div>`;
  return page('New prospect', `<h1>New prospect</h1>
<p>Enter the prospect's details. Relay shows a review step before it creates anything.</p>
${error}
<form class="panel" method="post" action="/review" accept-charset="UTF-8" autocomplete="off">
${hiddenField('requestId', options.requestId)}
${PROSPECT_FIELDS.map(name => formField(name, values[name] ?? '')).join('\n')}
<div class="actions"><button type="submit">Review prospect</button></div>
</form>
${requestIdMeta(options.requestId)}
${options.error === undefined ? '' : startOver}`);
}

export function renderIntakeReview(input: ProspectIntakeInput): string {
  const rows = PROSPECT_FIELDS.map(name => {
    const value = input[name];
    const shown = value === null ? '<span class="empty">Not provided</span>' : escapeHtml(value);
    return `<div><dt>${escapeHtml(FIELDS[name].label)}</dt><dd>${shown}</dd></div>`;
  }).join('\n');
  return page('Review prospect', `<h1>Review prospect</h1>
<p>Check these values. They are shown exactly as Relay will store them. Nothing is created until you confirm.</p>
<form class="panel" method="post" action="/prospects" accept-charset="UTF-8">
<dl>
${rows}
</dl>
${INTAKE_FIELDS.map(name => hiddenField(name, input[name] ?? '')).join('\n')}
<div class="actions">
<button type="submit" name="${INTAKE_CONFIRM_FIELD}" value="${INTAKE_CONFIRM_VALUE}">Confirm and create prospect</button>
<button type="submit" class="secondary" formaction="/edit">Edit</button>
</div>
</form>
${requestIdMeta(input.requestId)}`);
}

export function renderIntakeSuccess(result: ProspectIntakeResult, submittedRequestId: string): string {
  const heading = result.created ? 'Prospect created' : 'Prospect already recorded';
  const summary = result.created
    ? 'Relay created the prospect and recorded this intake request.'
    : 'This intake matches one Relay already recorded. No new prospect was created.';
  const replaced = result.requestId === submittedRequestId ? ''
    : `<p>Request ID <code>${escapeHtml(submittedRequestId)}</code> was not used. The intake is recorded under the request ID below.</p>`;
  return page(heading, `<h1>${heading}</h1>
<div class="notice success" role="status"><p>${summary}</p>${replaced}</div>
<div class="panel"><dl>
<div><dt>Prospect ID</dt><dd><code>${escapeHtml(result.prospectId)}</code></dd></div>
<div><dt>Stage</dt><dd>${escapeHtml(result.stage)}</dd></div>
<div><dt>Intake request ID</dt><dd><code>${escapeHtml(result.requestId)}</code></dd></div>
</dl></div>
<p class="meta"><a href="/">Start another intake</a></p>`);
}

// Intake conflicts roll back before any write, so this outcome is definite.
export function renderIntakeConflict(requestId: string, message: string): string {
  return page('Intake needs inspection', `<h1>Intake needs inspection</h1>
<div class="notice error" role="alert">
<p><strong>Relay did not create or change a prospect.</strong></p>
<p>${escapeHtml(message)}</p>
</div>
<p>Have this intake inspected before continuing. Do not change the request ID or the input to get past this conflict.</p>
${requestIdMeta(requestId)}`);
}

// Takes only the request ID so the page cannot echo submitted input or internal error details.
export function renderIntakeOutcomeUnknown(requestId: string): string {
  const id = `<code>${escapeHtml(requestId)}</code>`;
  return page('Outcome unknown', `<h1>Prospect outcome unknown</h1>
<div class="notice warning" role="alert">
<p><strong>Relay could not confirm whether the prospect was created.</strong></p>
<p>Do not start a new intake and do not change any values.</p>
</div>
<div class="panel">
<p><strong>To retry unchanged:</strong></p>
<ol>
<li>Use your browser's Back button to return to the review page. If the browser asks, allow it to resend the form.</li>
<li>Check that the review page shows intake request ID ${id}, then select <em>Confirm and create prospect</em> again.</li>
</ol>
<p>Retrying with the same request ID and the same values cannot create a second prospect.</p>
<p>If the retry also fails, stop and have intake request ${id} inspected.</p>
</div>`);
}

export function renderErrorPage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1>
<div class="notice error" role="alert"><p>${escapeHtml(message)}</p></div>
${startOver}`);
}
