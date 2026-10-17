import type { Pool, PoolClient } from 'pg';
import { safeResearchUrl } from '../research/research-evidence.js';
import type { ProspectStage } from '../outreach/types/prospect-stages.js';

export type ProspectIntakeInput = {
  requestId: string;
  companyName: string;
  website: string;
  industry: string | null;
  contactName: string | null;
  contactEmail: string | null;
  primaryDiscoveryQuestion: string | null;
};

type ProspectSnapshot = Omit<ProspectIntakeInput, 'requestId'>;
type IntakeRow = {
  id: string;
  prospect_id: string;
  identity_key: string;
  input_snapshot: ProspectSnapshot;
};
type ProspectRow = { id: string; stage: ProspectStage; website: string | null };

export type ProspectIntakeResult = {
  requestId: string;
  prospectId: string;
  stage: ProspectStage;
  created: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[A-Za-z0-9!#$%&'+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const ALLOWED_KEYS = new Set([
  'requestId', 'companyName', 'website', 'industry', 'contactName', 'contactEmail', 'primaryDiscoveryQuestion',
]);

function optionalText(value: unknown, field: string, maxBytes: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${field} must be a string or null.`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.includes('\0') || Buffer.byteLength(normalized) > maxBytes) {
    throw new Error(`${field} is invalid or too long.`);
  }
  return normalized;
}

export function parseProspectIntakePayload(input: unknown): ProspectIntakeInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Prospect intake input must be one JSON object.');
  }
  const value = input as Record<string, unknown>;
  const unknownKeys = Object.keys(value).filter(key => !ALLOWED_KEYS.has(key));
  if (unknownKeys.length) throw new Error('Prospect intake input contains unsupported fields.');
  if (typeof value.requestId !== 'string' || !UUID.test(value.requestId)) {
    throw new Error('requestId must be a UUID.');
  }
  if (typeof value.companyName !== 'string') throw new Error('companyName is required.');
  const companyName = value.companyName.trim();
  if (!companyName || /[\x00-\x1f\x7f]/.test(companyName) || Buffer.byteLength(companyName) > 200) {
    throw new Error('companyName must be nonblank, at most 200 UTF-8 bytes, and contain no control characters.');
  }
  if (typeof value.website !== 'string') throw new Error('website is required.');
  const website = safeResearchUrl(value.website.trim());
  const industry = optionalText(value.industry, 'industry', 120);
  const contactName = optionalText(value.contactName, 'contactName', 160);
  const contactEmailRaw = optionalText(value.contactEmail, 'contactEmail', 254);
  const contactEmail = contactEmailRaw?.toLowerCase() ?? null;
  if (contactEmail && (!EMAIL.test(contactEmail) || contactEmail.split('@')[0]!.length > 64
    || /email\s*protected|redacted|obfuscat/i.test(contactEmail))) {
    throw new Error('contactEmail must be one valid email address or null.');
  }
  const primaryDiscoveryQuestion = optionalText(value.primaryDiscoveryQuestion, 'primaryDiscoveryQuestion', 1000);
  return { requestId: value.requestId.toLowerCase(), companyName, website, industry, contactName,
    contactEmail, primaryDiscoveryQuestion };
}

function snapshot(input: ProspectIntakeInput): ProspectSnapshot {
  return { companyName: input.companyName, website: input.website, industry: input.industry,
    contactName: input.contactName, contactEmail: input.contactEmail,
    primaryDiscoveryQuestion: input.primaryDiscoveryQuestion };
}

function sameSnapshot(a: ProspectSnapshot, b: ProspectSnapshot): boolean {
  return a.companyName === b.companyName && a.website === b.website && a.industry === b.industry
    && a.contactName === b.contactName && a.contactEmail === b.contactEmail
    && a.primaryDiscoveryQuestion === b.primaryDiscoveryQuestion;
}

async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    client.release();
  }
}

async function existingResult(client: PoolClient, row: IntakeRow, requestId: string): Promise<ProspectIntakeResult> {
  const prospect = (await client.query<ProspectRow>('SELECT id, stage, website FROM prospects WHERE id = $1',
    [row.prospect_id])).rows[0];
  if (!prospect) throw new Error('Prospect intake journal points to a missing prospect; inspect before recovery.');
  return { requestId, prospectId: prospect.id, stage: prospect.stage, created: false };
}

export async function createProspectFromIntake(input: ProspectIntakeInput, database: Pool): Promise<ProspectIntakeResult> {
  const normalized = parseProspectIntakePayload(input);
  const inputSnapshot = snapshot(normalized);
  const identityKey = new URL(normalized.website).origin.toLowerCase();

  return transaction(database, async client => {
    const locks = [`identity:${identityKey}`, `request:${normalized.requestId}`].sort();
    for (const key of locks) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

    const byRequest = (await client.query<IntakeRow>(
      'SELECT id, prospect_id, identity_key, input_snapshot FROM prospect_intake_requests WHERE id = $1 FOR UPDATE',
      [normalized.requestId])).rows[0];
    if (byRequest) {
      if (byRequest.identity_key !== identityKey || !sameSnapshot(byRequest.input_snapshot, inputSnapshot)) {
        throw new Error('Prospect intake request ID already exists with different input; inspect before continuing.');
      }
      return existingResult(client, byRequest, normalized.requestId);
    }

    const byIdentity = (await client.query<IntakeRow>(
      'SELECT id, prospect_id, identity_key, input_snapshot FROM prospect_intake_requests WHERE identity_key = $1 FOR UPDATE',
      [identityKey])).rows[0];
    if (byIdentity) {
      if (!sameSnapshot(byIdentity.input_snapshot, inputSnapshot)) {
        throw new Error('A prospect intake already exists for this website with different input; inspect before updating it.');
      }
      return existingResult(client, byIdentity, normalized.requestId);
    }

    const legacy = await client.query<{ id: string; website: string | null }>(
      'SELECT id, website FROM prospects WHERE website IS NOT NULL');
    for (const prospect of legacy.rows) {
      try {
        if (new URL(prospect.website!).origin.toLowerCase() === identityKey) {
          throw new Error('A prospect already exists for this website; inspect it instead of creating another.');
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('A prospect already exists')) throw error;
      }
    }

    const prospect = (await client.query<ProspectRow>(`
      INSERT INTO prospects (
        company_name, website, industry, contact_name, contact_email, primary_discovery_question, stage
      ) VALUES ($1,$2,$3,$4,$5,$6,'researching')
      RETURNING id, stage, website`, [normalized.companyName, normalized.website, normalized.industry,
      normalized.contactName, normalized.contactEmail, normalized.primaryDiscoveryQuestion])).rows[0];
    if (!prospect) throw new Error('Prospect creation did not return a record.');

    await client.query(`INSERT INTO prospect_intake_requests (id, prospect_id, identity_key, input_snapshot)
      VALUES ($1,$2,$3,$4)`, [normalized.requestId, prospect.id, identityKey, JSON.stringify(inputSnapshot)]);

    return { requestId: normalized.requestId, prospectId: prospect.id, stage: prospect.stage, created: true };
  });
}
