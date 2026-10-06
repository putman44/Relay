// src/outreach/outreach-review.ts
import { db } from "../db.js";
import { getLatestOutreachDraft } from "./message-drafts.js";

type ProspectRow = {
  id: string;
  company_name: string;
  website: string | null;
  contact_name: string | null;
  contact_email: string | null;
  stage: string;
};

export type OutreachReview = {
  prospect: {
    id: string;
    companyName: string;
    website: string | null;
    contactName: string | null;
    contactEmail: string | null;
    stage: string;
  };
  draft: {
    id: string;
    subject: string;
    body: string;
    recipientEmail: string;
    reviewStatus: string;
    sendStatus: string;
  } | null;
};

export const getOutreachReview = async (
  prospectId: string,
): Promise<OutreachReview | null> => {
  const prospectResult = await db.query<ProspectRow>(
    `
      SELECT
        id,
        company_name,
        website,
        contact_name,
        contact_email,
        stage
      FROM prospects
      WHERE id = $1
      LIMIT 1;
    `,
    [prospectId],
  );

  const prospect = prospectResult.rows[0];

  if (!prospect) {
    return null;
  }

  const draft = await getLatestOutreachDraft(prospectId);

  return {
    prospect: {
      id: prospect.id,
      companyName: prospect.company_name,
      website: prospect.website,
      contactName: prospect.contact_name,
      contactEmail: prospect.contact_email,
      stage: prospect.stage,
    },
    draft: draft
      ? {
          id: draft.id,
          subject: draft.subject,
          body: draft.body,
          recipientEmail: draft.recipient_email,
          reviewStatus: draft.review_status,
          sendStatus: draft.send_status,
        }
      : null,
  };
};
