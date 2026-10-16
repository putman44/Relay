export type CreatedGmailDraft = {
  draftId: string;
  messageId: string;
  threadId: string;
};

export type GmailDraftCreator = (raw: string) => Promise<CreatedGmailDraft>;

export type GmailDraftCreationApi = {
  users: {
    drafts: {
      create: (
        request: { userId: string; requestBody: { message: { raw: string } } },
        options: { retry: false },
      ) => Promise<{
        data: {
          id?: string | null;
          message?: { id?: string | null; threadId?: string | null };
        };
      }>;
    };
  };
};

export const createGmailDraftCreator = (
  api: GmailDraftCreationApi,
): GmailDraftCreator => async (raw) => {
  const { data } = await api.users.drafts.create(
    { userId: "me", requestBody: { message: { raw } } },
    { retry: false },
  );
  if (!data.id?.trim() || !data.message?.id?.trim() || !data.message.threadId?.trim()) {
    throw new Error("Gmail draft creation returned incomplete identifiers; reconcile before retrying.");
  }
  return {
    draftId: data.id,
    messageId: data.message.id,
    threadId: data.message.threadId,
  };
};
