import { createHash } from "node:crypto";
import type { DashboardProspect } from "../data/research-embeddings.js";
import { askForm, ASK_STYLE } from "./ask-relay-pages.js";
import { escapeHtml } from "./intake-pages.js";

const STYLE = `${ASK_STYLE}
main{max-width:76rem;padding-top:1.5rem}
nav{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-bottom:1rem;border-bottom:1px solid var(--line)}
nav a{font-weight:600;text-decoration:none}
.dashboard-title{margin:1.75rem 0 1.25rem}
.layout{display:grid;grid-template-columns:minmax(13rem,18rem) minmax(0,1fr);gap:1.5rem;align-items:start}
.layout>section{min-width:0}
.list-heading{margin:0 0 .5rem;color:var(--muted);font-size:.8rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.prospects{list-style:none;margin:0;padding:0}
.prospects li{border-bottom:1px solid var(--line)}
.prospects a{display:block;padding:.7rem .6rem;text-decoration:none;color:var(--text);border-radius:.35rem;overflow-wrap:anywhere}
.prospects a:hover,.prospects a[aria-current=page]{background:var(--panel)}
.prospects a[aria-current=page]{font-weight:700;color:var(--accent)}
.prospects small{display:block;margin-top:.1rem;color:var(--muted);font-size:.8rem;font-weight:400}
.prospect-heading{margin:0;font-size:clamp(1.5rem,2.5vw,2rem);line-height:1.2;overflow-wrap:anywhere}
.ask-area>.panel{margin-top:1rem}
.ask-disclosure form{margin-top:1rem}
.details{margin-top:1.25rem}
.details summary{font-size:1rem}
.details dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:1.5rem;margin-top:.5rem}
.details dl div{min-width:0;padding:.45rem 0}
.details dd{overflow-wrap:anywhere}
@media(max-width:42rem){main{padding-top:1rem}.layout{grid-template-columns:1fr;gap:1.75rem}.details dl{grid-template-columns:1fr}}
`;
export const DASHBOARD_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${createHash("sha256").update(STYLE).digest("base64")}'`,
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

const STAGE_LABELS: Record<string, string> = {
  researching: "Research not started",
  research_in_progress: "Research in progress",
  needs_contact: "Contact needed",
  research_review: "Research needs review",
  draft_ready: "Draft ready",
  outreach_sent: "Outreach sent",
  send_reconciliation: "Send needs review",
  replied: "Reply received",
};

function statusLabel(prospect: DashboardProspect): string {
  return STAGE_LABELS[prospect.stage] ?? "Status unavailable";
}

export function renderDashboard(
  prospects: readonly DashboardProspect[],
  selected: DashboardProspect | undefined,
  askId: string,
  saved: "created" | "existing" | null,
  inline: { content: string; refresh: boolean } | null = null,
): string {
  const list = prospects.length
    ? `<ul class="prospects">${prospects.map((p) => `<li><a href="/prospect?id=${encodeURIComponent(p.id)}"${p.id === selected?.id ? ' aria-current="page"' : ""}>${escapeHtml(p.companyName)}<small>${escapeHtml(statusLabel(p))} · ${p.embeddedChunks ? "Ask Relay ready" : "Research not indexed"}</small></a></li>`).join("")}</ul>`
    : '<p class="empty">No saved prospects yet.</p>';
  const detail = selected
    ? `<section aria-label="Prospect detail">
<h2 class="prospect-heading">${escapeHtml(selected.companyName)}</h2>
<div class="ask-area">${selected.embeddedChunks ? `<details class="panel ask-disclosure" open><summary>Ask Relay</summary>${askForm({ askId, prospects: [selected], selected: selected.id, fixedProspect: true }, "Ask Relay", true)}</details>` : '<div class="notice warning" role="status"><p>Ask Relay is available after this prospect has indexed research.</p></div>'}${inline?.content ?? ""}</div>
${saved ? `<div class="notice success" role="status"><p>${saved === "created" ? "Prospect saved." : "Prospect already recorded. No duplicate was created."} Research has not started automatically.</p></div>` : ""}
<details class="panel details"><summary>Business details</summary><dl>
<div><dt>Website</dt><dd>${escapeHtml(selected.website ?? "Not provided")}</dd></div>
<div><dt>Industry</dt><dd>${escapeHtml(selected.industry ?? "Not provided")}</dd></div>
<div><dt>Contact</dt><dd>${escapeHtml(selected.contactName ?? "Not provided")}</dd></div>
<div><dt>Contact email</dt><dd>${escapeHtml(selected.contactEmail ?? "Not provided")}</dd></div>
<div><dt>Status</dt><dd>${escapeHtml(statusLabel(selected))}</dd></div>
<div><dt>Research</dt><dd>${selected.embeddedChunks ? `${selected.embeddedChunks} indexed chunks` : "Not indexed"}</dd></div>
</dl></details>
</section>`
    : '<section aria-label="Prospect detail"><p class="empty">Select a prospect to view details and Ask Relay.</p></section>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${inline?.refresh ? '<meta http-equiv="refresh" content="1">' : ""}<title>Prospects · Relay</title><style>${STYLE}</style></head><body><main><nav aria-label="Main"><a href="/">Relay</a><a href="/new">New Prospect</a></nav><h1 class="dashboard-title">Prospects</h1><div class="layout"><section aria-label="Saved prospects"><h2 class="list-heading">Saved prospects</h2>${list}</section>${detail}</div></main></body></html>`;
}
