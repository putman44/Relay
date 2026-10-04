// src/gmail/gmail-types.ts

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
