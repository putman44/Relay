// src/outreach-send.ts
import { db } from "./db.js";
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

export async function claimOutreachSend(
  prospectId: string,
  draftId: string,
): Promise<ClaimOutreachResult> {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const prospectResult = await client.query<Prospect>(
      `
        SELECT *
        FROM prospects
        WHERE id = $1
        FOR UPDATE;
      `,
      [prospectId],
    );

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

    if (!prospect) {
      await client.query("ROLLBACK");
      return {
        claimed: false,
        reason: "Prospect not found.",
      };
    }

    if (!draft) {
      await client.query("ROLLBACK");
      return {
        claimed: false,
        reason: "Outreach draft not found.",
      };
    }

    if (draft.send_status !== "pending") {
      await client.query("ROLLBACK");
      return {
        claimed: false,
        reason: `Draft cannot be claimed. Current send status: ${draft.send_status}`,
      };
    }

    const validation = validateOutreachSend(prospect, draft);

    if (!validation.valid) {
      await client.query("ROLLBACK");
      return {
        claimed: false,
        reason: validation.errors.join(" | "),
      };
    }

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

    await client.query("COMMIT");

    return {
      claimed: true,
      prospect,
      draft: updated.rows[0]!,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
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

export async function completeOutreachSend(
  prospectId: string,
  draftId: string,
  sentMessageId: string,
  gmailThreadId: string,
): Promise<CompleteOutreachResult> {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

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

    if (!draft) {
      await client.query("ROLLBACK");

      return {
        completed: false,
        reason: "Outreach draft not found.",
      };
    }

    if (draft.send_status !== "sending") {
      await client.query("ROLLBACK");

      return {
        completed: false,
        reason: `Draft cannot be completed. Current send status: ${draft.send_status}`,
      };
    }

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

export async function markOutreachNeedsReconciliation(
  prospectId: string,
  draftId: string,
  reason: string,
): Promise<CompleteOutreachResult> {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

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

    if (!draft) {
      await client.query("ROLLBACK");

      return {
        completed: false,
        reason: "Outreach draft not found.",
      };
    }

    if (draft.send_status !== "sending") {
      await client.query("ROLLBACK");

      return {
        completed: false,
        reason: `Draft cannot enter reconciliation. Current send status: ${draft.send_status}`,
      };
    }

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
