// src/outreach/outreach-send.ts

import { db } from "../db.js";
import type { MessageDraft } from "./message-drafts.js";
import { validateOutreachSend } from "./outreach-validation.js";
import type { Prospect } from "./prospects.js";

export type ClaimOutreachResult =
  | {
      claimed: true;
      prospect: Prospect;
      draft: MessageDraft;
    }
  | {
      claimed: false;
      reason: string;
    };

/**
 * Safely claims an outreach draft before a send attempt.
 *
 * Direct checks in this function:
 * 1. Does the prospect exist?
 * 2. Does the draft exist and belong to this prospect?
 *    - The SQL requires both the draft id and prospect_id to match.
 * 3. Is send_status still "pending"?
 *
 * validateOutreachSend() then checks:
 * 4. Is this actually an outreach draft?
 * 5. Is the prospect stage "draft_ready"?
 * 6. Is the draft approved?
 * 7. Does the prospect have a contact email?
 * 8. Is the recipient email valid?
 * 9. Does the recipient match the prospect contact email?
 * 10. Does the draft have a Gmail draft ID?
 * 11. Has the draft already been sent?
 *
 * If every check passes:
 *
 * pending -> sending
 *
 * The database transaction and FOR UPDATE row locks help prevent
 * two workers from successfully claiming the same draft at once.
 */
export async function claimOutreachSend(
  prospectId: string,
  draftId: string,
): Promise<ClaimOutreachResult> {
  const client = await db.connect();

  try {
    // Start a database transaction so the claim either fully succeeds
    // or fully rolls back.
    await client.query("BEGIN");

    // Lock the prospect row while we decide whether this send can be claimed.
    const prospectResult = await client.query<Prospect>(
      `
        SELECT *
        FROM prospects
        WHERE id = $1
        FOR UPDATE;
      `,
      [prospectId],
    );

    // Lock the draft row and require it to belong to this prospect.
    const draftResult = await client.query<MessageDraft>(
      `
        SELECT *
        FROM message_drafts
        WHERE id = $1
          AND prospect_id = $2
        FOR UPDATE;
      `,
      [draftId, prospectId],
    );

    const prospect = prospectResult.rows[0];
    const draft = draftResult.rows[0];

    // Check 1: the prospect must exist.
    if (!prospect) {
      await client.query("ROLLBACK");

      return {
        claimed: false,
        reason: "Prospect not found.",
      };
    }

    // Check 2: the draft must exist and belong to this prospect.
    if (!draft) {
      await client.query("ROLLBACK");

      return {
        claimed: false,
        reason: "Outreach draft not found.",
      };
    }

    // Check 3: only a pending draft may begin a new send attempt.
    if (draft.send_status !== "pending") {
      await client.query("ROLLBACK");

      return {
        claimed: false,
        reason: `Draft cannot be claimed. Current send status: ${draft.send_status}`,
      };
    }

    // Run the remaining outreach business-rule checks before
    // changing the draft into the sending state.
    const validation = validateOutreachSend(prospect, draft);

    if (!validation.valid) {
      await client.query("ROLLBACK");

      return {
        claimed: false,
        reason: validation.errors.join(" | "),
      };
    }

    // All safety checks passed.
    // Claim the draft by moving it from pending -> sending.
    const updated = await client.query<MessageDraft>(
      `
        UPDATE message_drafts
        SET
          send_status = 'sending',
          updated_at = now()
        WHERE id = $1
        RETURNING *;
      `,
      [draftId],
    );

    // Make the state change permanent.
    await client.query("COMMIT");

    return {
      claimed: true,
      prospect,
      draft: updated.rows[0]!,
    };
  } catch (error) {
    // If anything unexpected fails, undo the transaction.
    await client.query("ROLLBACK");
    throw error;
  } finally {
    // Return this dedicated database connection to the pool.
    client.release();
  }
}

export type CompleteOutreachResult =
  | {
      completed: true;
      draft: MessageDraft;
    }
  | {
      completed: false;
      reason: string;
    };

/**
 * Finalizes an outreach send only after Gmail has confirmed success.
 *
 * Checks:
 * 1. Does the draft exist and belong to this prospect?
 * 2. Is the draft currently "sending"?
 *
 * If valid:
 *
 * draft:
 * sending -> sent
 *
 * prospect:
 * -> outreach_sent
 *
 * The Gmail message ID, Gmail thread ID, and sent timestamp
 * are stored as part of the successful send record.
 *
 * The draft and prospect updates happen inside one transaction,
 * so they commit together.
 */
export async function completeOutreachSend(
  prospectId: string,
  draftId: string,
  sentMessageId: string,
  gmailThreadId: string,
): Promise<CompleteOutreachResult> {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Lock the draft while completing the send.
    // The draft must also belong to the supplied prospect.
    const draftResult = await client.query<MessageDraft>(
      `
        SELECT *
        FROM message_drafts
        WHERE id = $1
          AND prospect_id = $2
        FOR UPDATE;
      `,
      [draftId, prospectId],
    );

    const draft = draftResult.rows[0];

    // Check 1: the draft must exist and belong to the prospect.
    if (!draft) {
      await client.query("ROLLBACK");

      return {
        completed: false,
        reason: "Outreach draft not found.",
      };
    }

    // Check 2: only a draft currently being sent may be completed.
    //
    // This prevents things like:
    // pending -> sent
    // sent -> sent again
    // needs_reconciliation -> sent automatically
    if (draft.send_status !== "sending") {
      await client.query("ROLLBACK");

      return {
        completed: false,
        reason: `Draft cannot be completed. Current send status: ${draft.send_status}`,
      };
    }

    // Gmail confirmed success.
    // Store the authoritative send result.
    const updatedDraft = await client.query<MessageDraft>(
      `
        UPDATE message_drafts
        SET
          send_status = 'sent',
          review_status = 'sent',
          sent_message_id = $3,
          gmail_thread_id = $4,
          sent_at = now(),
          updated_at = now()
        WHERE id = $1
          AND prospect_id = $2
        RETURNING *;
      `,
      [draftId, prospectId, sentMessageId, gmailThreadId],
    );

    // Move the overall prospect workflow forward too.
    await client.query(
      `
        UPDATE prospects
        SET
          stage = 'outreach_sent',
          updated_at = now()
        WHERE id = $1;
      `,
      [prospectId],
    );

    await client.query("COMMIT");

    return {
      completed: true,
      draft: updatedDraft.rows[0]!,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Stops automatic processing when Gmail's send result is uncertain.
 *
 * An uncertain result does NOT necessarily mean Gmail failed.
 * It means Relay cannot prove whether Gmail sent the message.
 *
 * Checks:
 * 1. Does the draft exist and belong to this prospect?
 * 2. Is the draft currently "sending"?
 *
 * If valid:
 *
 * draft:
 * sending -> needs_reconciliation
 *
 * prospect:
 * -> send_reconciliation
 *
 * Relay also stores:
 * - the error/reason
 * - the reconciliation timestamp
 *
 * This prevents Relay from blindly retrying an uncertain send
 * and potentially sending a duplicate email.
 */
export async function markOutreachNeedsReconciliation(
  prospectId: string,
  draftId: string,
  reason: string,
): Promise<CompleteOutreachResult> {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Lock the draft while moving it into reconciliation.
    // The draft must belong to the supplied prospect.
    const draftResult = await client.query<MessageDraft>(
      `
        SELECT *
        FROM message_drafts
        WHERE id = $1
          AND prospect_id = $2
        FOR UPDATE;
      `,
      [draftId, prospectId],
    );

    const draft = draftResult.rows[0];

    // Check 1: the draft must exist and belong to the prospect.
    if (!draft) {
      await client.query("ROLLBACK");

      return {
        completed: false,
        reason: "Outreach draft not found.",
      };
    }

    // Check 2: only an active send attempt can become uncertain.
    if (draft.send_status !== "sending") {
      await client.query("ROLLBACK");

      return {
        completed: false,
        reason: `Draft cannot enter reconciliation. Current send status: ${draft.send_status}`,
      };
    }

    // The external send outcome is uncertain.
    // Stop automatic processing and preserve the failure context.
    const updated = await client.query<MessageDraft>(
      `
        UPDATE message_drafts
        SET
          send_status = 'needs_reconciliation',
          send_error = $3,
          reconciliation_at = now(),
          updated_at = now()
        WHERE id = $1
          AND prospect_id = $2
        RETURNING *;
      `,
      [draftId, prospectId, reason],
    );

    // Move the prospect into the human-review reconciliation stage.
    await client.query(
      `
        UPDATE prospects
        SET
          stage = 'send_reconciliation',
          updated_at = now()
        WHERE id = $1;
      `,
      [prospectId],
    );

    await client.query("COMMIT");

    return {
      completed: true,
      draft: updated.rows[0]!,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
