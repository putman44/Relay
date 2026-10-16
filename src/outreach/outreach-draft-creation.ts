import type { Pool } from "pg";
import type { CreatedGmailDraft, GmailDraftCreator } from "../gmail/gmail-draft-creator.js";
import type { MessageDraft } from "./message-drafts.js";
import {
  buildOutreachDraftMime,
  type OutreachDraftContent,
} from "./outreach-draft-content.js";

type DraftCreationDependencies = {
  database: Pool;
  createGmailDraft: GmailDraftCreator;
};

export const createOutreachDraft = async (
  content: OutreachDraftContent,
  { database, createGmailDraft }: DraftCreationDependencies,
): Promise<MessageDraft> => {
  const input = { ...content };
  const raw = buildOutreachDraftMime(input);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ contact_email: string | null; stage: string }>(
      "SELECT contact_email, stage FROM prospects WHERE id = $1 FOR UPDATE",
      [input.prospectId],
    );
    const prospect = rows[0];
    if (!prospect || prospect.stage !== "researching"
      || prospect.contact_email?.toLowerCase() !== input.recipientEmail.toLowerCase()) {
      throw new Error("Draft creation requires a researching prospect and its exact contact email.");
    }
    const existing = await client.query(
      "SELECT id FROM message_drafts WHERE prospect_id = $1 AND draft_type = 'outreach' LIMIT 1",
      [input.prospectId],
    );
    if (existing.rowCount) throw new Error("Prospect already has an outreach draft.");
    await client.query(
      `INSERT INTO outreach_draft_requests (id, prospect_id, recipient_email, subject, body)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.requestId, input.prospectId, input.recipientEmail, input.subject, input.body],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // The committed request survives process failure. Neither creating nor
  // uncertain requests may automatically invoke Gmail a second time.
  let gmail: CreatedGmailDraft | undefined;
  try {
    gmail = await createGmailDraft(raw);
    if (!gmail.draftId?.trim() || !gmail.messageId?.trim() || !gmail.threadId?.trim()) {
      throw new Error("Gmail draft creation returned incomplete identifiers.");
    }
    const finalizer = await database.connect();
    try {
      await finalizer.query("BEGIN");
      const { rows } = await finalizer.query<{ contact_email: string | null; stage: string }>(
        "SELECT contact_email, stage FROM prospects WHERE id = $1 FOR UPDATE",
        [input.prospectId],
      );
      const prospect = rows[0];
      if (!prospect || prospect.stage !== "researching"
        || prospect.contact_email?.toLowerCase() !== input.recipientEmail.toLowerCase()) {
        throw new Error("Prospect changed during Gmail draft creation; reconcile the created draft.");
      }
      const existing = await finalizer.query(
        "SELECT id FROM message_drafts WHERE prospect_id = $1 AND draft_type = 'outreach' LIMIT 1",
        [input.prospectId],
      );
      if (existing.rowCount) throw new Error("An outreach draft appeared during creation; reconcile before continuing.");
      const completed = await finalizer.query(
        `UPDATE outreach_draft_requests SET status = 'created', gmail_draft_id = $2,
         gmail_message_id = $3, gmail_thread_id = $4, updated_at = now()
         WHERE id = $1 AND status = 'creating' RETURNING id`,
        [input.requestId, gmail.draftId, gmail.messageId, gmail.threadId],
      );
      if (!completed.rowCount) throw new Error("Draft request is no longer creating; reconcile before continuing.");
      const result = await finalizer.query<MessageDraft>(
        `INSERT INTO message_drafts
         (id, prospect_id, recipient_email, subject, body, gmail_draft_id, gmail_thread_id,
          draft_type, review_status, send_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'outreach', 'needs_review', 'pending') RETURNING *`,
        [input.requestId, input.prospectId, input.recipientEmail, input.subject, input.body, gmail.draftId, gmail.threadId],
      );
      await finalizer.query("UPDATE prospects SET stage = 'draft_ready', updated_at = now() WHERE id = $1", [input.prospectId]);
      await finalizer.query("COMMIT");
      return result.rows[0]!;
    } catch (error) {
      await finalizer.query("ROLLBACK");
      throw error;
    } finally {
      finalizer.release();
    }
  } catch (error) {
    try {
      await database.query(
        `UPDATE outreach_draft_requests SET status = 'needs_reconciliation',
         gmail_draft_id = $2, gmail_message_id = $3, gmail_thread_id = $4,
         last_error = 'Gmail draft creation or local finalization failed; verify Gmail before recovery.',
         updated_at = now() WHERE id = $1 AND status = 'creating'`,
        [input.requestId, gmail?.draftId ?? null, gmail?.messageId ?? null, gmail?.threadId ?? null],
      );
    } catch {
      // The original creating record remains a durable block if the DB is down.
    }
    throw new Error(`Draft request ${input.requestId} requires reconciliation; do not retry automatically.`, { cause: error });
  }
};
