import type { Pool } from "pg";
import type {
  ResearchDependencies,
  ResearchRequest,
  ResearchStartPolicy,
} from "../research/prospect-research.js";
import type { IntakeResearchDependencies } from "./intake-server.js";

export type IntakeResearchWorkflow = {
  startProspectResearch: (
    prospectId: string,
    deps: ResearchDependencies,
    policy: ResearchStartPolicy,
  ) => Promise<ResearchRequest>;
  getResearchRequest: (
    prospectId: string,
    database: Pool,
  ) => Promise<ResearchRequest | null>;
  createProviders: () => Pick<
    ResearchDependencies,
    "scrape" | "research" | "drive" | "driveParentId"
  >;
};

// Loaded on first use, so the intake form itself needs no research configuration.
async function loadResearchWorkflow(): Promise<IntakeResearchWorkflow> {
  const { getResearchRequest, startProspectResearch } =
    await import("../research/prospect-research.js");
  const { createFirecrawlScraper } =
    await import("../research/firecrawl-scraper.js");
  const { createOpenAIResearcher } =
    await import("../research/openai-researcher.js");
  const { createResearchDrive } =
    await import("../research/drive-artifacts.js");
  return {
    getResearchRequest,
    startProspectResearch,
    createProviders: () => ({
      scrape: createFirecrawlScraper(),
      research: createOpenAIResearcher(),
      drive: createResearchDrive(),
      driveParentId: process.env.RELAY_RESEARCH_DRIVE_PARENT_ID ?? "",
    }),
  };
}

// Intake-initiated research is research-only: the stored policy forbids a Gmail
// draft and no Gmail draft client is ever constructed.
export function createIntakeResearch(
  database: Pool,
  load: () => Promise<IntakeResearchWorkflow> = loadResearchWorkflow,
): IntakeResearchDependencies & { idle: () => Promise<void> } {
  const running = new Set<Promise<unknown>>();
  return {
    getRequest: async (prospectId) =>
      (await load()).getResearchRequest(prospectId, database),
    start(prospectId) {
      const run = (async () => {
        const workflow = await load();
        return workflow.startProspectResearch(
          prospectId,
          {
            database,
            ...workflow.createProviders(),
            createGmailDraft: async () => {
              throw new Error(
                "Gmail draft creation is disabled for intake research.",
              );
            },
          },
          { gmailDraftAllowed: false },
        );
      })();
      running.add(run);
      const settled = () => {
        running.delete(run);
      };
      run.then(settled, settled);
      return run;
    },
    // Resolves once no research started here is still running, so shutdown can wait for a durable checkpoint.
    idle: async () => {
      await Promise.allSettled(running);
    },
  };
}
