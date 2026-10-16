// src/outreach/prospects.ts
import { db } from "../db.js";
import type { ProspectStage } from "./types/prospect-stages.js";

export type Prospect = {
  id: string;
  company_name: string;
  industry?: string | null;
  website: string | null;
  contact_name: string | null;
  contact_email: string | null;
  stage: ProspectStage;
  cold_outreach_blocked?: boolean;
  communication_opted_out?: boolean;
  primary_discovery_question?: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function listProspects(): Promise<Prospect[]> {
  const result = await db.query<Prospect>(`
    SELECT
      id,
      company_name,
      industry,
      website,
      contact_name,
      contact_email,
      stage,
      cold_outreach_blocked,
      communication_opted_out,
      primary_discovery_question,
      created_at,
      updated_at
    FROM prospects
    ORDER BY created_at DESC;
  `);

  return result.rows;
}

export async function getProspectById(id: string): Promise<Prospect | null> {
  const result = await db.query<Prospect>(
    `
      SELECT
        id,
        company_name,
        industry,
        website,
        contact_name,
        contact_email,
        stage,
        cold_outreach_blocked,
        communication_opted_out,
        primary_discovery_question,
        created_at,
        updated_at
      FROM prospects
      WHERE id = $1
      LIMIT 1;
    `,
    [id],
  );

  return result.rows[0] ?? null;
}
