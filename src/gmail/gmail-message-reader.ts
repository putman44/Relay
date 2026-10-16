export type GmailRawMessage = {
  id?: string | null; threadId?: string | null; labelIds?: string[] | null; raw?: string | null;
};
export type GmailMessageReader = (id: string) => Promise<GmailRawMessage>;
export type GmailMessageApi = { users: { messages: {
  get: (request: { userId: string; id: string; format: 'raw' }) => Promise<{ data: GmailRawMessage }>;
} } };
export const createGmailMessageReader = (api: GmailMessageApi): GmailMessageReader => async id => {
  try { return (await api.users.messages.get({ userId: 'me', id, format: 'raw' })).data; }
  catch (error) { throw new Error('Inbound message read failed.', { cause: error }); }
};
