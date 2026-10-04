// src/outreach-validation.ts
import type { MessageDraft } from "./message-drafts.js";
import type { Prospect } from "./prospects.js";

export type OutreachValidationResult = {
  valid: boolean;
  errors: string[];
};

function isValidEmail(email: string): boolean {
  return (
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    !email.includes("[") &&
    !email.includes("]") &&
    !email.includes("*") &&
    !/email\s*protected|redacted|obfuscat/i.test(email)
  );
}

export function validateOutreachSend(
  prospect: Prospect,
  draft: MessageDraft,
): OutreachValidationResult {
  const errors: string[] = [];

  if (draft.prospect_id !== prospect.id) {
    errors.push("Draft does not belong to this prospect.");
  }

  if (draft.draft_type !== "outreach") {
    errors.push("Draft is not an outreach draft.");
  }

  if (prospect.stage !== "draft_ready") {
    errors.push(
      `Prospect stage must be draft_ready. Current stage: ${prospect.stage}`,
    );
  }

  if (draft.review_status !== "approved") {
    errors.push(
      `Draft must be approved. Current review status: ${draft.review_status}`,
    );
  }

  if (!prospect.contact_email) {
    errors.push("Prospect does not have a contact email.");
  }

  if (!isValidEmail(draft.recipient_email)) {
    errors.push("Draft recipient email is invalid.");
  }

  if (
    prospect.contact_email &&
    draft.recipient_email.toLowerCase() !== prospect.contact_email.toLowerCase()
  ) {
    errors.push("Draft recipient does not match prospect contact email.");
  }

  if (!draft.gmail_draft_id) {
    errors.push("Gmail draft ID is missing.");
  }

  if (draft.sent_at || draft.sent_message_id) {
    errors.push("Draft appears to have already been sent.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
