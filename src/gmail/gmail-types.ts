// src/gmail/gmail-types.ts

import type { CompleteOutreachResult } from "../outreach/outreach-send.js";

// discriminated union
export type GmailSendResult =
  | {
      status: "sent";
      messageId: string;
      threadId: string;
    }
  | {
      status: "uncertain";
      error: string;
    };

export type GmailDraftSender = (
  gmailDraftId: string,
) => Promise<GmailSendResult>;

export type GmailResultFinalizer = (
  prospectId: string,
  draftId: string,
  result: GmailSendResult,
) => Promise<CompleteOutreachResult>;
