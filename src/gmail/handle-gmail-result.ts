// src/gmail/handle-gmail-result.ts
import {
  completeOutreachSend,
  markOutreachNeedsReconciliation,
} from "../outreach/outreach-send.js";
import type { GmailSendResult } from "./gmail-types.js";

export const handleGmailSendResult = async (
  prospectId: string,
  draftId: string,
  result: GmailSendResult,
) => {
  if (result.status === "sent") {
    await completeOutreachSend(
      prospectId,
      draftId,
      result.messageId,
      result.threadId,
    );
  } else {
    await markOutreachNeedsReconciliation(prospectId, draftId, result.error);
  }
};
