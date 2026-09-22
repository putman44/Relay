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
