import { createHash } from "node:crypto";
import type { DashboardProspect } from "../data/research-embeddings.js";
import { askForm, ASK_STYLE } from "./ask-relay-pages.js";
import { escapeHtml } from "./intake-pages.js";

const STYLE = `${ASK_STYLE}
main{max-width:68rem}
nav{display:flex;gap:1rem;padding-bottom:1rem;border-bottom:1px solid var(--line)}
.layout{display:grid;grid-template-columns:minmax(14rem,21rem) minmax(0,1fr);gap:1.5rem;align-items:start}
.prospects{list-style:none;margin:0;padding:0}
.prospects li{border-bottom:1px solid var(--line)}
.prospects a{display:block;padding:.8rem .2rem;text-decoration:none;color:var(--text)}
.prospects a[aria-current=page]{font-weight:700;color:var(--accent)}
.prospects small{display:block;color:var(--muted);font-weight:400}
@media(max-width:42rem){.layout{grid-template-columns:1fr}}
`;
export const DASHBOARD_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${createHash("sha256").update(STYLE).digest("base64")}'`,
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

export function renderDashboard(
  prospects: readonly DashboardProspect[],
  selected: DashboardProspect | undefined,
  askId: string,
  saved: "created" | "existing" | null,
): string {
  const list = prospects.length
    ? `<ul class="prospects">${prospects.map((p) => `<li><a href="/prospect?id=${encodeURIComponent(p.id)}"${p.id === selected?.id ? ' aria-current="page"' : ""}>${escapeHtml(p.companyName)}<small>${escapeHtml(p.website ?? "No website")} · ${escapeHtml(p.industry ?? "Industry not provided")}</small><small>${p.embeddedChunks ? `${p.embeddedChunks} indexed chunks · Ready for Ask Relay` : "Research not indexed"}</small></a></li>`).join("")}</ul>`
    : '<p class="empty">No saved prospects yet.</p>';
  const detail = selected
    ? `<section aria-label="Prospect detail"><h2>${escapeHtml(selected.companyName)}</h2>
${saved ? `<div class="notice success" role="status"><p>${saved === "created" ? "Prospect saved." : "Prospect already recorded. No duplicate was created."} Research has not started automatically.</p></div>` : ""}
<div class="panel"><dl>
<div><dt>Website</dt><dd>${escapeHtml(selected.website ?? "Not provided")}</dd></div>
<div><dt>Industry</dt><dd>${escapeHtml(selected.industry ?? "Not provided")}</dd></div>
<div><dt>Contact</dt><dd>${escapeHtml(selected.contactName ?? "Not provided")}</dd></div>
<div><dt>Contact email</dt><dd>${escapeHtml(selected.contactEmail ?? "Not provided")}</dd></div>
<div><dt>Stage</dt><dd>${escapeHtml(selected.stage)}</dd></div>
<div><dt>Research readiness</dt><dd>${selected.embeddedChunks ? `${selected.embeddedChunks} indexed chunks` : "No embeddings yet. Research and indexing must be started separately."}</dd></div>
</dl></div>
${selected.embeddedChunks ? askForm({ askId, prospects: [selected], selected: selected.id }, "Ask Relay") : '<div class="notice warning" role="status"><p>Ask Relay is unavailable until this prospect has indexed research.</p></div>'}
</section>`
    : '<section aria-label="Prospect detail"><p class="empty">Select a prospect to view details and Ask Relay.</p></section>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Prospects · Relay</title><style>${STYLE}</style></head><body><main><nav aria-label="Main"><a href="/">Prospects</a><a href="/new">New Prospect</a></nav><h1>Prospects</h1><div class="layout"><section aria-label="Saved prospects">${list}</section>${detail}</div></main></body></html>`;
}
