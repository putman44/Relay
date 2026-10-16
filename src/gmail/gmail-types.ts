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
  approvedDraft?: ApprovedGmailDraft,
) => Promise<GmailSendResult>;

export type ApprovedGmailDraft = {
  recipientEmail: string;
  subject: string;
  body: string;
  threadId: string | null;
  parentMessageId?: string;
};

export type GmailResultFinalizer = (
  prospectId: string,
  draftId: string,
  result: GmailSendResult,
) => Promise<CompleteOutreachResult>;
