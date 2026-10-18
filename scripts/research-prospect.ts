import 'dotenv/config';
import { parseResearchArgs } from '../src/operator/research-input.js';
import { researchMutationOutput, researchStatusOutput } from '../src/operator/research-output.js';

async function main() {
  const command = parseResearchArgs(process.argv.slice(2));
  const { db } = await import('../src/db.js');
  try {
    const { getResearchRequest, startProspectResearch, resumeProspectResearch, retryFailedPreArtifactResearch } =
      await import('../src/research/prospect-research.js');
    if (command.action === 'status') {
      const request = await getResearchRequest(command.prospectId, db);
      console.log(JSON.stringify(researchStatusOutput(request)));
      return;
    }
    const { createFirecrawlScraper } = await import('../src/research/firecrawl-scraper.js');
    const { createOpenAIResearcher } = await import('../src/research/openai-researcher.js');
    const { createResearchDrive } = await import('../src/research/drive-artifacts.js');
    const safeResearch = command.action === 'start-safe';
    const createGmailDraft = safeResearch
      ? async () => { throw new Error('Gmail draft creation is disabled for safe research.'); }
      : (await import('../src/gmail/gmail-runtime.js')).createProductionGmailDraftCreator();
    const deps = { database: db, scrape: createFirecrawlScraper(), research: createOpenAIResearcher(),
      drive: createResearchDrive(), createGmailDraft,
      driveParentId: process.env.RELAY_RESEARCH_DRIVE_PARENT_ID ?? '' };
    const request = command.action === 'start' || command.action === 'start-safe'
      ? await startProspectResearch(command.prospectId, deps, { gmailDraftAllowed: !safeResearch })
      : command.action === 'retry-pre-artifact'
        ? await retryFailedPreArtifactResearch(command.requestId, deps)
        : await resumeProspectResearch(command.requestId, deps);
    console.log(JSON.stringify(researchMutationOutput(request)));
  } finally { await db.end(); }
}
main().catch(() => { console.error('Research operation stopped; inspect the durable request before recovery.'); process.exitCode = 1; });
