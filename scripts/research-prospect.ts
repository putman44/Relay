import 'dotenv/config';
import { parseResearchArgs } from '../src/operator/research-input.js';

async function main() {
  const command = parseResearchArgs(process.argv.slice(2));
  const { db } = await import('../src/db.js');
  try {
    const { getResearchRequest, startProspectResearch, resumeProspectResearch, retryFailedPreArtifactResearch } =
      await import('../src/research/prospect-research.js');
    if (command.action === 'status') {
      const request = await getResearchRequest(command.prospectId, db);
      console.log(JSON.stringify(request && { id: request.id, prospectId: request.prospect_id,
        status: request.status, folderId: request.folder_id, briefId: request.brief_id,
        briefUrl: request.brief_url, gmailDraftId: request.gmail_draft_id,
        lastError: request.last_error }));
      return;
    }
    const { createFirecrawlScraper } = await import('../src/research/firecrawl-scraper.js');
    const { createOpenAIResearcher } = await import('../src/research/openai-researcher.js');
    const { createResearchDrive } = await import('../src/research/drive-artifacts.js');
    const { createProductionGmailDraftCreator } = await import('../src/gmail/gmail-runtime.js');
    const deps = { database: db, scrape: createFirecrawlScraper(), research: createOpenAIResearcher(),
      drive: createResearchDrive(), createGmailDraft: createProductionGmailDraftCreator(),
      driveParentId: process.env.RELAY_RESEARCH_DRIVE_PARENT_ID ?? '' };
    const request = command.action === 'start'
      ? await startProspectResearch(command.prospectId, deps)
      : command.action === 'retry-pre-artifact'
        ? await retryFailedPreArtifactResearch(command.requestId, deps)
        : await resumeProspectResearch(command.requestId, deps);
    console.log(JSON.stringify({ id: request.id, prospectId: request.prospect_id, status: request.status,
      folderId: request.folder_id, briefId: request.brief_id, briefUrl: request.brief_url,
      gmailDraftId: request.gmail_draft_id }));
  } finally { await db.end(); }
}
main().catch(() => { console.error('Research operation stopped; inspect the durable request before recovery.'); process.exitCode = 1; });
