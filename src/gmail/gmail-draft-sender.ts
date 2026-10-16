// src/gmail/gmail-draft-sender.ts

import type { GmailDraftSender } from "./gmail-types.js";

export type GmailDraftApi = {
  users: {
    drafts: {
      send: (request: {
        userId: string;
        requestBody: {
          id: string;
          message?: { raw: string; threadId: string };
        };
      }, options?: { retry: false }) => Promise<{
        data: {
          id?: string | null;
          threadId?: string | null;
        };
      }>;
    };
  };
};

export const createGmailDraftSender = (
  gmailApi: GmailDraftApi,
  verifiedMessage?: { raw: string; threadId: string },
): GmailDraftSender => {
  return async (gmailDraftId) => {
    const response = await gmailApi.users.drafts.send(
      {
        userId: "me",
        requestBody: {
          id: gmailDraftId,
          ...(verifiedMessage ? { message: verifiedMessage } : {}),
        },
      },
      { retry: false },
    );

    const messageId = response.data.id;
    const threadId = response.data.threadId;

    if (!messageId || !threadId) {
      throw new Error(
        `Gmail send returned incomplete message data for draft ${gmailDraftId}`,
      );
    }

    return {
      status: "sent",
      messageId,
      threadId,
    };
  };
};
