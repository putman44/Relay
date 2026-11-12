import type { Pool } from "pg";
import { safeResearchUrl } from "../research/research-evidence.js";

type Database = Pick<Pool, "query">;

export type ResearchPageType =
  | "homepage"
  | "about"
  | "services"
  | "contact"
  | "team"
  | "faq"
  | "case_study"
  | "blog"
  | "other";

export type ResearchDocument = {
  id: string;
  prospect_id: string;
  research_request_id: string;
  source_url: string;
  page_type: ResearchPageType;
  title: string | null;
  content: string;
  scraped_at: Date;
  created_at: Date;
};

export type ResearchChunk = {
  id: string;
  prospect_id: string;
  research_document_id: string;
  content: string;
  embedding: null;
  source_url: string;
  chunk_index: number;
  created_at: Date;
};

export type CommunicationDirection = "inbound" | "outbound";
export type Communication = {
  id: string;
  prospect_id: string;
  direction: CommunicationDirection;
  channel: "email";
  gmail_message_id: string;
  gmail_thread_id: string | null;
  subject: string;
  body: string;
  sent_at: Date | null;
  received_at: Date | null;
  status: "sent" | "received";
  created_at: Date;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_TYPES = new Set<ResearchPageType>([
  "homepage",
  "about",
  "services",
  "contact",
  "team",
  "faq",
  "case_study",
  "blog",
  "other",
]);

function uuid(value: string, field: string): string {
  if (!UUID.test(value)) throw new Error(`${field} must be a UUID.`);
  return value.toLowerCase();
}

function text(
  value: string,
  field: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value) > maxBytes ||
    (!allowEmpty && !value.trim())
  )
    throw new Error(`${field} is invalid or too long.`);
  return value;
}

function optionalText(
  value: string | null,
  field: string,
  maxBytes: number,
): string | null {
  if (value === null) return null;
  const normalized = text(value.trim(), field, maxBytes);
  return normalized;
}

function timestamp(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error(`${field} must be a valid date.`);
  return value;
}

export async function createResearchDocument(
  input: {
    prospectId: string;
    researchRequestId: string;
    sourceUrl: string;
    pageType: ResearchPageType;
    title: string | null;
    content: string;
    scrapedAt: Date;
  },
  database: Database,
): Promise<ResearchDocument> {
  const prospectId = uuid(input.prospectId, "prospectId");
  const researchRequestId = uuid(input.researchRequestId, "researchRequestId");
  const sourceUrl = safeResearchUrl(input.sourceUrl);
  if (!PAGE_TYPES.has(input.pageType)) throw new Error("pageType is invalid.");
  const title = optionalText(input.title, "title", 1000);
  const content = text(input.content, "content", 1_000_000);
  const scrapedAt = timestamp(input.scrapedAt, "scrapedAt");

  const result = await database.query<ResearchDocument>(
    `
    INSERT INTO research_documents (
      prospect_id, research_request_id, source_url,
      page_type, title, content, scraped_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (research_request_id, source_url)
      DO NOTHING
    RETURNING *
  `,
    [
      prospectId,
      researchRequestId,
      sourceUrl,
      input.pageType,
      title,
      content,
      scrapedAt,
    ],
  );

  if (result.rows[0]) return result.rows[0];

  const existing = await database.query<ResearchDocument>(
    `
    SELECT *
    FROM research_documents
    WHERE research_request_id = $1
      AND source_url = $2
  `,
    [researchRequestId, sourceUrl],
  );

  const document = existing.rows[0];

  if (
    !document ||
    document.prospect_id !== prospectId ||
    document.page_type !== input.pageType ||
    document.title !== title ||
    document.content !== content ||
    document.scraped_at.getTime() !== scrapedAt.getTime()
  ) {
    throw new Error(
      "Existing research document conflicts with saved evidence.",
    );
  }

  return document;
}

export async function createResearchChunk(
  input: {
    prospectId: string;
    researchDocumentId: string;
    content: string;
    chunkIndex: number;
  },
  database: Database,
): Promise<ResearchChunk> {
  const prospectId = uuid(input.prospectId, "prospectId");
  const researchDocumentId = uuid(
    input.researchDocumentId,
    "researchDocumentId",
  );
  const content = text(input.content, "content", 100_000);
  if (!Number.isSafeInteger(input.chunkIndex) || input.chunkIndex < 0) {
    throw new Error("chunkIndex must be a nonnegative safe integer.");
  }
  const result = await database.query<ResearchChunk>(
    `
    INSERT INTO research_chunks (
      prospect_id, research_document_id, content, source_url, chunk_index
    )
    SELECT $1, id, $3, source_url, $4
    FROM research_documents
    WHERE id = $2 AND prospect_id = $1
    RETURNING *`,
    [prospectId, researchDocumentId, content, input.chunkIndex],
  );
  const chunk = result.rows[0];
  if (!chunk) throw new Error("Research document does not match the prospect.");
  return chunk;
}

type EmailCommunicationInput = {
  prospectId: string;
  gmailMessageId: string;
  gmailThreadId: string | null;
  subject: string;
  body: string;
} & (
  | { direction: "inbound"; receivedAt: Date }
  | { direction: "outbound"; sentAt: Date }
);

export async function createEmailCommunication(
  input: EmailCommunicationInput,
  database: Database,
): Promise<Communication> {
  const prospectId = uuid(input.prospectId, "prospectId");
  const gmailMessageId = text(
    input.gmailMessageId.trim(),
    "gmailMessageId",
    500,
  );
  const gmailThreadId = optionalText(input.gmailThreadId, "gmailThreadId", 500);
  const subject = text(input.subject, "subject", 10_000, true);
  const body = text(input.body, "body", 1_000_000, true);
  const inbound = input.direction === "inbound";
  const occurredAt = timestamp(
    inbound ? input.receivedAt : input.sentAt,
    inbound ? "receivedAt" : "sentAt",
  );
  const result = await database.query<Communication>(
    `
    INSERT INTO communications (
      prospect_id, direction, channel, gmail_message_id, gmail_thread_id,
      subject, body, sent_at, received_at, status
    ) VALUES ($1,$2,'email',$3,$4,$5,$6,$7,$8,$9)
    RETURNING *`,
    [
      prospectId,
      input.direction,
      gmailMessageId,
      gmailThreadId,
      subject,
      body,
      inbound ? null : occurredAt,
      inbound ? occurredAt : null,
      inbound ? "received" : "sent",
    ],
  );
  const communication = result.rows[0];
  if (!communication)
    throw new Error("Communication persistence did not return a record.");
  return communication;
}
