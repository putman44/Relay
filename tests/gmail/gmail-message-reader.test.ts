import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createGmailMessageReader } from '../../src/gmail/gmail-message-reader.js';
import { createGmailDraftCreator } from '../../src/gmail/gmail-draft-creator.js';

test('Reply message reader: fetches raw exact message without mailbox mutations', async () => {
  const snapshot = { id: 'reply', threadId: 'thread', raw: 'encoded' };
  const reader = createGmailMessageReader({ users: { messages: { get: async request => {
    assert.deepEqual(request, { userId: 'me', id: 'reply', format: 'raw' }); return { data: snapshot };
  } } } });
  assert.equal(await reader('reply'), snapshot);
});
test('Reply draft creator: passes explicit thread ID with transport retries disabled', async () => {
  const creator = createGmailDraftCreator({ users: { drafts: { create: async (request, options) => {
    assert.deepEqual(request, { userId: 'me', requestBody: { message: { raw: 'encoded', threadId: 'thread' } } });
    assert.equal(options.retry, false);
    return { data: { id: 'draft', message: { id: 'message', threadId: 'thread' } } };
  } } } });
  assert.equal((await creator('encoded', 'thread')).threadId, 'thread');
});
