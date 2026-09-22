// src/handle-gmail-result.ts
import type { GmailSendResult } from "./gmail-types.js";
import {
  completeOutreachSend,
  markOutreachNeedsReconciliation,
} from "./outreach-send.js";

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
