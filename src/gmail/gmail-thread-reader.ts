export type GmailThread = {
  id?: string | null;
  messages?: Array<{
    id?: string | null;
    threadId?: string | null;
    internalDate?: string | null;
    labelIds?: string[] | null;
    snippet?: string | null;
    payload?: { headers?: Array<{ name?: string | null; value?: string | null }> };
  }>;
};
export type GmailThreadReader = (threadId: string) => Promise<GmailThread>;
export type GmailThreadApi = { users: { threads: {
  get: (request: { userId: string; id: string; format: 'full' }) => Promise<{ data: GmailThread }>;
} } };

export class GmailThreadUnavailableError extends Error {}

export const createGmailThreadReader = (api: GmailThreadApi): GmailThreadReader => async (id) => {
  try {
    return (await api.users.threads.get({ userId: 'me', id, format: 'full' })).data;
  } catch (error) {
    const status = (error as { response?: { status?: number } } | null)?.response?.status;
    if (status === 404 || status === 410) throw new GmailThreadUnavailableError('Gmail thread is unavailable.');
    // Auth, rate limits, malformed requests, and outages are not empty threads.
    throw new Error('Gmail thread read failed.', { cause: error });
  }
};
