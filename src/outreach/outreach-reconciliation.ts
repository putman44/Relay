// src/outreach/outreach-reconciliation.ts

import { db } from "../db.js";
import type { MessageDraft } from "./message-drafts.js";
import type { Prospect } from "./prospects.js";

export type ResolveOutreachReconciliationResult =
  | {
      resolved: true;
      draft: MessageDraft;
    }
  | {
      resolved: false;
      reason: string;
    };

export async function resolveOutreachReconciliationAsNotSent(
  prospectId: string,
  draftId: string,
): Promise<ResolveOutreachReconciliationResult> {
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
        resolved: false,
        reason: "Prospect not found.",
      };
    }

    if (!draft) {
      await client.query("ROLLBACK");

      return {
        resolved: false,
        reason: "Outreach draft not found.",
      };
    }

    if (prospect.stage !== "send_reconciliation") {
      await client.query("ROLLBACK");

      return {
        resolved: false,
        reason: `Prospect is not awaiting reconciliation. Current stage: ${prospect.stage}`,
      };
    }

    if (draft.send_status !== "needs_reconciliation") {
      await client.query("ROLLBACK");

      return {
        resolved: false,
        reason: `Draft is not awaiting reconciliation. Current send status: ${draft.send_status}`,
      };
    }

    if (draft.sent_message_id || draft.sent_at) {
      await client.query("ROLLBACK");

      return {
        resolved: false,
        reason: "Draft already contains confirmed send evidence.",
      };
    }

    const updatedDraftResult = await client.query<MessageDraft>(
      `
        UPDATE message_drafts
        SET
          send_status = 'pending',
          send_error = NULL,
          reconciliation_at = NULL,
          updated_at = now()
        WHERE id = $1
          AND prospect_id = $2
        RETURNING *;
      `,
      [draftId, prospectId],
    );

    await client.query(
      `
        UPDATE prospects
        SET
          stage = 'draft_ready',
          updated_at = now()
        WHERE id = $1;
      `,
      [prospectId],
    );

    await client.query("COMMIT");

    return {
      resolved: true,
      draft: updatedDraftResult.rows[0]!,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
