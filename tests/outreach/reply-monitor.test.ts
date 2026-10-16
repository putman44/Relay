import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findInboundReplies } from '../../src/outreach/reply-monitor.js';
import type { GmailThread } from '../../src/gmail/gmail-thread-reader.js';

const message = (id: string, at = 2000, labels: string[] = ['INBOX']) => ({
  id, threadId: 'thread', internalDate: String(at), labelIds: labels,
  snippet: 'Reply preview', payload: { headers: [{ name: 'From', value: 'person@example.com' }, { name: 'Subject', value: 'Re: Hello' }] },
});
const sent = message('sent', 1000, ['SENT']);
test('Reply detection: excludes sent/draft/old messages, records all newer inbound in stable order', () => {
  const replies = findInboundReplies({ id: 'thread', messages: [
    message('newest', 5000), message('outbound', 3000, ['SENT']), message('draft', 4000, ['DRAFT']),
    sent, message('old', 999), message('earliest'),
  ] }, 'thread', 'sent');
  assert.deepEqual(replies.map(r => r.messageId), ['earliest', 'newest']);
  assert.equal(replies[0]?.sender, 'person@example.com');
  assert.equal(replies[0]?.subject, 'Re: Hello');
});
test('Reply detection: archived replies, bounces and automatic replies still stop cold outreach', () => {
  assert.equal(findInboundReplies({ id: 'thread', messages: [sent, message('auto', 2000, [])] }, 'thread', 'sent').length, 1);
});
test('Reply detection: malformed and incomplete responses fail closed instead of no-reply', () => {
  const cases: GmailThread[] = [{}, { id: 'wrong', messages: [message('m')] }, { id: 'thread' }, { id: 'thread', messages: [] },
    ...[ { id: '' }, { threadId: 'wrong' }, { internalDate: '' }, { internalDate: 'NaN' },
      { internalDate: '9007199254740992' } ].map(change => ({ id: 'thread', messages: [{ ...message('m'), ...change }] })),
    { id: 'thread', messages: [message('duplicate'), message('duplicate')] }];
  for (const candidate of cases) {
    const withAnchor = candidate.id === 'thread' && candidate.messages?.length
      ? { ...candidate, messages: [sent, ...candidate.messages] } : candidate;
    assert.throws(() => findInboundReplies(withAnchor, 'thread', 'sent'));
  }
  assert.throws(() => findInboundReplies({ id: 'thread', messages: [message('m')] }, 'thread', 'absent'));
});
test('Reply detection: same-millisecond inbound and fast replies before DB finalization are retained', () => {
  const replies = findInboundReplies({ id: 'thread', messages: [sent, message('same-ms', 1000), message('fast', 1001)] }, 'thread', 'sent');
  assert.deepEqual(replies.map(r => r.messageId), ['same-ms', 'fast']);
  assert.deepEqual(findInboundReplies({ id: 'thread', messages: [sent] }, 'thread', 'sent'), []);
});
test('Reply detection: omitted empty labels conservatively retain an archived inbound message', () => {
  const replies = findInboundReplies({ id: 'thread', messages: [sent, { ...message('archived'), labelIds: null }] }, 'thread', 'sent');
  assert.equal(replies[0]?.messageId, 'archived');
});
