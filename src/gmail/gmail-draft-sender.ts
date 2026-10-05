// src/gmail/gmail-draft-sender.ts

import type { GmailDraftSender } from "./gmail-types.js";

export type GmailDraftApi = {
  users: {
    drafts: {
      send: (request: {
        userId: string;
        requestBody: {
          id: string;
        };
      }) => Promise<{
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
): GmailDraftSender => {
  return async (gmailDraftId) => {
    const response = await gmailApi.users.drafts.send({
      userId: "me",
      requestBody: {
        id: gmailDraftId,
      },
    });

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
