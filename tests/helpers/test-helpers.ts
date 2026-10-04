// tests/helpers/test-helpers.ts
import { db } from "../../src/db.js";
import type { ProspectStage } from "../../src/outreach/types/prospect-stages.js";
import type { ReviewStatus } from "../../src/outreach/types/review-statuses.js";

type CreateTestProspectOptions = {
  companyName?: string;
  website?: string;
  contactName?: string;
  contactEmail?: string;
  stage?: ProspectStage;
};

export const createTestProspect = async ({
  companyName = "Relay Test Prospect",
  website = "https://devbytaylor.com",
  contactName = "Taylor Test",
  contactEmail = "test@devbytaylor.com",
  stage = "draft_ready",
}: CreateTestProspectOptions = {}): Promise<string> => {
  const prospectInsertResult = await db.query<{ id: string }>(
    `
   INSERT INTO prospects (
     company_name,
     website,
     contact_name,
     contact_email,
     stage
   )
   VALUES ($1, $2, $3, $4, $5)
   RETURNING id;
 `,
    [companyName, website, contactName, contactEmail, stage],
  );

  const prospect = prospectInsertResult.rows[0];
  if (!prospect) {
    throw new Error("Failed to create test prospect");
  }

  return prospect.id;
};

type CreateTestDraftOptions = {
  prospectId: string;
  recipientEmail?: string;
  subject?: string;
  body?: string;
  gmailDraftId?: string | null;
  reviewStatus?: ReviewStatus;
  sentMessageId?: string | null;
  sentAt?: Date | null;
};

export const createTestDraft = async ({
  prospectId,
  recipientEmail = "test@devbytaylor.com",
  subject = "Relay test draft",
  body = "Controlled development-only test draft.",
  gmailDraftId = `TEST_DRAFT_${Date.now()}`,
  reviewStatus = "approved",
  sentMessageId = null,
  sentAt = null,
}: CreateTestDraftOptions): Promise<string> => {
  const draftResult = await db.query<{ id: string }>(
    `
              INSERT INTO message_drafts (
                prospect_id,
                recipient_email,
                subject,
                body,
                review_status, 
                gmail_draft_id,
                sent_message_id,
                sent_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              RETURNING id;
            `,
    [
      prospectId,
      recipientEmail,
      subject,
      body,
      reviewStatus,
      gmailDraftId,
      sentMessageId,
      sentAt,
    ],
  );

  const draft = draftResult.rows[0];
  if (!draft) {
    throw new Error("Failed to create test draft");
  }

  return draft.id;
};
