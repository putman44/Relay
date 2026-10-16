import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { GmailDraftCreator, CreatedGmailDraft } from '../gmail/gmail-draft-creator.js';
import { buildOutreachDraftMime } from '../outreach/outreach-draft-content.js';
import { responseBodyWithSignature } from '../outreach/reply-context.js';
import { collectResearchEvidence, safeResearchUrl, validateResearchEvidence,
  type PageScraper, type ResearchEvidence } from './research-evidence.js';
import { validateDriveArtifact, validDriveId, type DriveArtifact, type ResearchDrive } from './drive-artifacts.js';
import { renderResearchBrief, validateResearchResult, type ResearchResult } from './research-result.js';
import type { ResearchInput, Researcher } from './openai-researcher.js';

type Status = 'researching' | 'research_ready' | 'folder_creating' | 'folder_ready' | 'brief_creating'
  | 'brief_ready' | 'draft_creating' | 'completed' | 'needs_contact' | 'research_review' | 'failed' | 'needs_reconciliation';
export type ResearchRequest = {
  id: string; prospect_id: string; status: Status; owner_token: string; input_snapshot: ResearchInput;
  drive_parent_id: string; evidence: ResearchEvidence | null; result: ResearchResult | null;
  folder_id: string | null; brief_id: string | null; brief_url: string | null;
  gmail_draft_id: string | null; gmail_message_id: string | null; gmail_thread_id: string | null;
  last_error: string | null;
  updated_at: Date;
};
type ProspectRow = ResearchInput & { id: string; stage: string; cold_outreach_blocked: boolean;
  communication_opted_out: boolean };
export type ResearchDependencies = { database: Pool; scrape: PageScraper; research: Researcher;
  drive: ResearchDrive; createGmailDraft: GmailDraftCreator; driveParentId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const snapshot = (row: ResearchInput): ResearchInput => ({ company_name: row.company_name, website: row.website,
  industry: row.industry, contact_email: row.contact_email, contact_name: row.contact_name,
  primary_discovery_question: row.primary_discovery_question });
const sameSnapshot = (a: ResearchInput, b: ResearchInput): boolean =>
  (Object.keys(snapshot(a)) as (keyof ResearchInput)[]).every(key => a[key] === b[key]);

async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await run(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally { client.release(); }
}

async function locked(client: PoolClient, requestId: string, owner: string, expected: Status): Promise<{
  prospect: ProspectRow; request: ResearchRequest;
}> {
  const selected = await client.query<ResearchRequest>('SELECT * FROM prospect_research_requests WHERE id = $1', [requestId]);
  const candidate = selected.rows[0];
  if (!candidate) throw new Error('Research request does not exist.');
  const prospect = (await client.query<ProspectRow>('SELECT * FROM prospects WHERE id = $1 FOR UPDATE',
    [candidate.prospect_id])).rows[0];
  const request = (await client.query<ResearchRequest>('SELECT * FROM prospect_research_requests WHERE id = $1 FOR UPDATE',
    [requestId])).rows[0];
  if (!prospect || !request || request.owner_token !== owner || request.status !== expected
    || prospect.stage !== 'research_in_progress'
    || prospect.cold_outreach_blocked || prospect.communication_opted_out
    || !sameSnapshot(prospect, request.input_snapshot)) {
    throw new Error('Research ownership, prospect snapshot, or stage changed; inspect before continuing.');
  }
  return { prospect, request };
}

async function advance(pool: Pool, id: string, owner: string, from: Status, to: Status,
  updates: Record<string, unknown> = {}): Promise<ResearchRequest> {
  return transaction(pool, async client => {
    await locked(client, id, owner, from);
    const keys = Object.keys(updates);
    const assignments = keys.map((key, index) => `${key} = $${index + 5}`);
    const query = `UPDATE prospect_research_requests SET status = $3, ${assignments.length ? assignments.join(', ') + ', ' : ''}
      updated_at = now() WHERE id = $1 AND owner_token = $2 AND status = $4
      RETURNING *`;
    const result = await client.query<ResearchRequest>(query, [id, owner, to, from, ...keys.map(key => updates[key])]);
    if (result.rowCount !== 1) throw new Error('Research request state changed.');
    return result.rows[0]!;
  });
}

async function hold(pool: Pool, id: string, owner: string, from: Status,
  returned: Partial<Pick<ResearchRequest, 'folder_id' | 'brief_id' | 'brief_url' | 'gmail_draft_id' | 'gmail_message_id' | 'gmail_thread_id'>> = {}): Promise<void> {
  try {
    const entries = Object.entries(returned);
    const assignments = entries.map(([key], index) => `${key} = $${index + 4}`).join(', ');
    await pool.query(`UPDATE prospect_research_requests SET status = 'needs_reconciliation',
      last_error = 'Artifact outcome or local finalization is uncertain; inspect providers before recovery.',
      ${assignments ? assignments + ', ' : ''}updated_at = now()
      WHERE id = $1 AND owner_token = $2 AND status = $3`,
    [id, owner, from, ...entries.map(([, value]) => value)]);
  } catch { /* A creating row is itself a durable block when Postgres is unavailable. */ }
}

export async function startProspectResearch(prospectId: string, deps: ResearchDependencies): Promise<ResearchRequest> {
  if (!UUID.test(prospectId) || !validDriveId(deps.driveParentId)) throw new Error('Valid prospect and Drive parent IDs are required.');
  const id = randomUUID(), owner = randomUUID();
  await transaction(deps.database, async client => {
    const prospect = (await client.query<ProspectRow>('SELECT * FROM prospects WHERE id = $1 FOR UPDATE', [prospectId])).rows[0];
    if (!prospect || prospect.stage !== 'researching' || prospect.cold_outreach_blocked || prospect.communication_opted_out
      || !prospect.company_name?.trim() || !prospect.website) throw new Error('Prospect is not eligible for public research.');
    safeResearchUrl(prospect.website);
    const conflict = await client.query(`SELECT 1 FROM outreach_draft_requests WHERE prospect_id = $1
      UNION ALL SELECT 1 FROM message_drafts WHERE prospect_id = $1 AND draft_type = 'outreach' LIMIT 1`, [prospectId]);
    if (conflict.rowCount) throw new Error('Prospect already has an outreach request or draft.');
    await client.query(`INSERT INTO prospect_research_requests
      (id, prospect_id, status, owner_token, input_snapshot, drive_parent_id)
      VALUES ($1,$2,'researching',$3,$4,$5)`,
    [id, prospectId, owner, JSON.stringify(snapshot(prospect)), deps.driveParentId]);
    await client.query("UPDATE prospects SET stage = 'research_in_progress', updated_at = now() WHERE id = $1", [prospectId]);
  });
  return runResearch(id, owner, deps);
}

export async function resumeProspectResearch(requestId: string, deps: ResearchDependencies): Promise<ResearchRequest> {
  if (!UUID.test(requestId)) throw new Error('Valid research request ID required.');
  const owner = randomUUID();
  await transaction(deps.database, async client => {
    const request = (await client.query<ResearchRequest>('SELECT * FROM prospect_research_requests WHERE id = $1',
      [requestId])).rows[0];
    if (!request || !(['research_ready', 'folder_ready', 'brief_ready'].includes(request.status)
      || (request.status === 'researching'
        && Date.now() - new Date(request.updated_at).getTime() >= 2 * 60 * 60 * 1000))
      || request.drive_parent_id !== deps.driveParentId) throw new Error('Research has no safe resume checkpoint.');
    const prospect = (await client.query<ProspectRow>('SELECT * FROM prospects WHERE id = $1 FOR UPDATE',
      [request.prospect_id])).rows[0];
    if (!prospect || prospect.stage !== 'research_in_progress' || prospect.cold_outreach_blocked
      || prospect.communication_opted_out
      || !sameSnapshot(prospect, request.input_snapshot)) {
      throw new Error('Prospect changed; inspect research before resuming.');
    }
    const replaced = await client.query(`UPDATE prospect_research_requests SET owner_token = $2, updated_at = now()
      WHERE id = $1 AND status = $3 RETURNING id`, [requestId, owner, request.status]);
    if (replaced.rowCount !== 1) throw new Error('Research checkpoint changed.');
  });
  return runResearch(requestId, owner, deps);
}

export async function getResearchRequest(prospectId: string, database: Pool): Promise<ResearchRequest | null> {
  if (!UUID.test(prospectId)) throw new Error('Valid prospect ID required.');
  return (await database.query<ResearchRequest>('SELECT * FROM prospect_research_requests WHERE prospect_id = $1',
    [prospectId])).rows[0] ?? null;
}

async function finishWithoutDraft(pool: Pool, id: string, owner: string, result: ResearchResult,
  reason: 'needs_contact' | 'research_review'): Promise<ResearchRequest> {
  return transaction(pool, async client => {
    const { prospect } = await locked(client, id, owner, 'brief_ready');
    await client.query(`UPDATE prospects SET stage = $2, industry = COALESCE(industry, NULLIF($3,'')),
      primary_discovery_question = COALESCE(primary_discovery_question,$4), updated_at = now() WHERE id = $1`,
    [prospect.id, reason, result.industry, result.primaryDiscoveryQuestion]);
    const completed = await client.query<ResearchRequest>(`UPDATE prospect_research_requests
      SET status = $2, updated_at = now() WHERE id = $1 AND owner_token = $3 AND status = 'brief_ready' RETURNING *`,
    [id, reason, owner]);
    if (completed.rowCount !== 1) throw new Error('Research checkpoint changed.');
    return completed.rows[0]!;
  });
}

async function finishWithDraft(pool: Pool, id: string, owner: string, result: ResearchResult,
  gmail: CreatedGmailDraft): Promise<ResearchRequest> {
  return transaction(pool, async client => {
    const { prospect } = await locked(client, id, owner, 'draft_creating');
    if (!result.recommendedContact.email || !gmail.draftId?.trim() || !gmail.messageId?.trim() || !gmail.threadId?.trim()) {
      throw new Error('Draft contact or Gmail IDs are incomplete.');
    }
    const existing = await client.query(`SELECT id FROM message_drafts WHERE prospect_id = $1 AND draft_type = 'outreach' LIMIT 1`,
      [prospect.id]);
    if (existing.rowCount) throw new Error('Outreach draft appeared during research.');
    const body = responseBodyWithSignature(result.outreachBody);
    await client.query(`INSERT INTO message_drafts
      (id, prospect_id, recipient_email, subject, body, gmail_draft_id, gmail_thread_id,
       draft_type, review_status, send_status, research_request_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'outreach','needs_review','pending',$1)`,
    [id, prospect.id, result.recommendedContact.email, result.outreachSubject, body,
      gmail.draftId, gmail.threadId]);
    await client.query(`UPDATE prospects SET stage = 'draft_ready',
      contact_email = COALESCE(contact_email,$2), contact_name = COALESCE(contact_name,NULLIF($3,'')),
      industry = COALESCE(industry,NULLIF($4,'')),
      primary_discovery_question = COALESCE(primary_discovery_question,$5), updated_at = now() WHERE id = $1`,
    [prospect.id, result.recommendedContact.email, result.recommendedContact.name,
      result.industry, result.primaryDiscoveryQuestion]);
    const completed = await client.query<ResearchRequest>(`UPDATE prospect_research_requests SET status = 'completed',
      gmail_draft_id = $2, gmail_message_id = $3, gmail_thread_id = $4, updated_at = now()
      WHERE id = $1 AND owner_token = $5 AND status = 'draft_creating' RETURNING *`,
    [id, gmail.draftId, gmail.messageId, gmail.threadId, owner]);
    if (completed.rowCount !== 1) throw new Error('Research checkpoint changed.');
    return completed.rows[0]!;
  });
}

async function runResearch(id: string, owner: string, deps: ResearchDependencies): Promise<ResearchRequest> {
  let request = (await deps.database.query<ResearchRequest>('SELECT * FROM prospect_research_requests WHERE id = $1', [id])).rows[0]!;
  const input = request.input_snapshot;
  if (request.status === 'researching') {
    try {
      const evidence = await collectResearchEvidence(input.website, deps.scrape);
      const output = await deps.research(input, evidence);
      const result = validateResearchResult(output, input, evidence, id, request.prospect_id);
      request = await advance(deps.database, id, owner, 'researching', 'research_ready',
        { evidence: JSON.stringify(evidence), result: JSON.stringify(result) });
    } catch (error) {
      try {
        await transaction(deps.database, async client => {
          const { prospect } = await locked(client, id, owner, 'researching');
          await client.query(`UPDATE prospect_research_requests SET status = 'failed',
            last_error = 'Research or validation failed; inspect before new work.', updated_at = now()
            WHERE id = $1 AND owner_token = $2 AND status = 'researching'`, [id, owner]);
          await client.query("UPDATE prospects SET stage = 'research_review', updated_at = now() WHERE id = $1", [prospect.id]);
        });
      } catch { /* The reservation still blocks a duplicate request. */ }
      throw new Error(`Research request ${id} failed validation or collection.`, { cause: error });
    }
  }
  if (!request.evidence || !request.result) throw new Error('Research checkpoint lacks evidence or result.');
  const evidence = validateResearchEvidence(request.evidence, input.website);
  const result = validateResearchResult(request.result, input, evidence, id, request.prospect_id);
  if (request.status === 'research_ready') {
    request = await advance(deps.database, id, owner, 'research_ready', 'folder_creating');
    let folder: DriveArtifact | undefined;
    try {
      folder = await deps.drive.createFolder(id, request.drive_parent_id, `${result.companyName} - Relay Research`);
      validateDriveArtifact(folder, folder.id, request.drive_parent_id, id, 'folder');
      request = await advance(deps.database, id, owner, 'folder_creating', 'folder_ready', { folder_id: folder.id });
    } catch (error) {
      await hold(deps.database, id, owner, 'folder_creating', { folder_id: folder?.id ?? null });
      throw new Error(`Research folder for ${id} requires reconciliation.`, { cause: error });
    }
  }
  if (request.status === 'folder_ready') {
    try {
      if (!request.folder_id) throw new Error('Folder ID missing.');
      validateDriveArtifact(await deps.drive.get(request.folder_id), request.folder_id,
        request.drive_parent_id, id, 'folder');
    } catch (error) {
      await hold(deps.database, id, owner, 'folder_ready');
      throw new Error(`Research folder for ${id} could not be verified.`, { cause: error });
    }
    request = await advance(deps.database, id, owner, 'folder_ready', 'brief_creating');
    let brief: DriveArtifact | undefined;
    try {
      brief = await deps.drive.createBrief(id, request.folder_id!, `${result.companyName} - Research Brief`,
        renderResearchBrief(result, evidence));
      validateDriveArtifact(brief, brief.id, request.folder_id!, id, 'brief');
      request = await advance(deps.database, id, owner, 'brief_creating', 'brief_ready',
        { brief_id: brief.id, brief_url: brief.webViewLink ?? null });
    } catch (error) {
      await hold(deps.database, id, owner, 'brief_creating', { brief_id: brief?.id ?? null, brief_url: brief?.webViewLink ?? null });
      throw new Error(`Research brief for ${id} requires reconciliation.`, { cause: error });
    }
  }
  if (request.status === 'brief_ready') {
    try {
      if (!request.folder_id || !request.brief_id) throw new Error('Drive IDs missing.');
      validateDriveArtifact(await deps.drive.get(request.folder_id), request.folder_id,
        request.drive_parent_id, id, 'folder');
      validateDriveArtifact(await deps.drive.get(request.brief_id), request.brief_id, request.folder_id, id, 'brief');
    } catch (error) {
      await hold(deps.database, id, owner, 'brief_ready');
      throw new Error(`Research artifacts for ${id} could not be verified.`, { cause: error });
    }
    if (result.fit === 'C') return finishWithoutDraft(deps.database, id, owner, result, 'research_review');
    if (!result.recommendedContact.email) return finishWithoutDraft(deps.database, id, owner, result, 'needs_contact');
    request = await advance(deps.database, id, owner, 'brief_ready', 'draft_creating');
    let gmail: CreatedGmailDraft | undefined;
    try {
      const raw = buildOutreachDraftMime({ requestId: id, prospectId: request.prospect_id,
        recipientEmail: result.recommendedContact.email, subject: result.outreachSubject,
        body: responseBodyWithSignature(result.outreachBody) });
      gmail = await deps.createGmailDraft(raw);
      return await finishWithDraft(deps.database, id, owner, result, gmail);
    } catch (error) {
      await hold(deps.database, id, owner, 'draft_creating', {
        gmail_draft_id: gmail?.draftId ?? null, gmail_message_id: gmail?.messageId ?? null,
        gmail_thread_id: gmail?.threadId ?? null,
      });
      throw new Error(`Research Gmail draft for ${id} requires reconciliation.`, { cause: error });
    }
  }
  throw new Error('Research request has no runnable checkpoint.');
}
