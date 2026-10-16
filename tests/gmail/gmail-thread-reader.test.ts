import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createGmailThreadReader, GmailThreadUnavailableError } from '../../src/gmail/gmail-thread-reader.js';

test('Thread reader: reads full thread without mailbox mutations', async () => {
  const thread = { id: 'thread', messages: [] };
  const reader = createGmailThreadReader({ users: { threads: { get: async request => {
    assert.deepEqual(request, { userId: 'me', id: 'thread', format: 'full' });
    return { data: thread };
  } } } });
  assert.equal(await reader('thread'), thread);
});

test('Thread reader: only 404/410 mean unavailable; auth and outages remain failures', async () => {
  for (const status of [400, 401, 403, 404, 410, 429, 500]) {
    const reader = createGmailThreadReader({ users: { threads: { get: async () => {
      throw { response: { status } };
    } } } });
    await assert.rejects(reader('thread'), error => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof GmailThreadUnavailableError, status === 404 || status === 410);
      return true;
    });
  }
});
