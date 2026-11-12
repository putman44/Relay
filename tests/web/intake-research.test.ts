import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Pool } from "pg";
import type {
  ResearchDependencies,
  ResearchRequest,
  ResearchStartPolicy,
} from "../../src/research/prospect-research.js";
import {
  createIntakeResearch,
  type IntakeResearchWorkflow,
} from "../../src/web/intake-research.js";

const PROSPECT_ID = "0b5d7e3a-9c41-4b8f-a2d6-31e5f7c9a804";
const unused = async (): Promise<never> => {
  throw new Error("unused");
};

// Never queried: the fake workflow below stands in for every database and provider call.
const database = {} as Pool;
const request = {
  id: "3e9a1c57-2b6d-4f80-9a1e-5c7d2f4b6a90",
  prospect_id: PROSPECT_ID,
  status: "research_review",
} as ResearchRequest;
const providers: ReturnType<IntakeResearchWorkflow["createProviders"]> = {
  scrape: unused,
  research: unused,
  drive: { createFolder: unused, createBrief: unused, get: unused },
  driveParentId: "parentfolder12345",
};

type StartCall = {
  prospectId: string;
  deps: ResearchDependencies;
  policy: ResearchStartPolicy;
};

function fakeWorkflow(overrides: Partial<IntakeResearchWorkflow> = {}): {
  load: () => Promise<IntakeResearchWorkflow>;
  starts: StartCall[];
  lookups: [string, Pool][];
  providersCreated: () => number;
} {
  const starts: StartCall[] = [];
  const lookups: [string, Pool][] = [];
  let created = 0;
  const workflow: IntakeResearchWorkflow = {
    startProspectResearch: async (prospectId, deps, policy) => {
      starts.push({ prospectId, deps, policy });
      return request;
    },
    getResearchRequest: async (prospectId, pool) => {
      lookups.push([prospectId, pool]);
      return request;
    },
    createProviders: () => {
      created++;
      return providers;
    },
    ...overrides,
  };
  return {
    load: async () => workflow,
    starts,
    lookups,
    providersCreated: () => created,
  };
}

test("Intake research: start runs the existing workflow research-only with Gmail draft creation disabled", async () => {
  const fake = fakeWorkflow();
  const research = createIntakeResearch(database, fake.load);

  assert.equal(await research.start(PROSPECT_ID), request);
  assert.equal(fake.starts.length, 1);
  const { prospectId, deps, policy } = fake.starts[0]!;
  assert.equal(prospectId, PROSPECT_ID);
  assert.deepEqual(policy, { gmailDraftAllowed: false });
  assert.equal(deps.database, database);
  assert.equal(deps.scrape, providers.scrape);
  assert.equal(deps.research, providers.research);
  assert.equal(deps.drive, providers.drive);
  assert.equal(deps.driveParentId, providers.driveParentId);
  await assert.rejects(
    () => deps.createGmailDraft("raw message"),
    /Gmail draft creation is disabled for intake research\./,
  );
});

test("Intake research: a status read uses the existing lookup and builds no provider client", async () => {
  const fake = fakeWorkflow();
  const research = createIntakeResearch(database, fake.load);

  assert.equal(await research.getRequest(PROSPECT_ID), request);
  assert.deepEqual(fake.lookups, [[PROSPECT_ID, database]]);
  assert.equal(fake.providersCreated(), 0);
  assert.equal(fake.starts.length, 0);
});

test("Intake research: incomplete provider configuration rejects the start before the workflow runs", async () => {
  const fake = fakeWorkflow({
    createProviders: () => {
      throw new Error("FIRECRAWL_API_KEY is required.");
    },
  });
  const research = createIntakeResearch(database, fake.load);

  await assert.rejects(
    () => research.start(PROSPECT_ID),
    /FIRECRAWL_API_KEY is required\./,
  );
  assert.equal(fake.starts.length, 0);
  await research.idle();
});

test("Intake research: idle waits for running research, including research that fails", async () => {
  let fail!: (error: Error) => void;
  const fake = fakeWorkflow({
    startProspectResearch: () =>
      new Promise<ResearchRequest>((_resolve, reject) => {
        fail = reject;
      }),
  });
  const research = createIntakeResearch(database, fake.load);
  await research.idle();

  const run = research.start(PROSPECT_ID);
  let idle = false;
  const waiting = research.idle().then(() => {
    idle = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, false);

  fail(new Error("Research request failed validation or collection."));
  await assert.rejects(run, /failed validation or collection/);
  await waiting;
  assert.equal(idle, true);
});
