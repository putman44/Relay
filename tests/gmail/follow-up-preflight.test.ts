import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildResponseDraftMime } from '../../src/outreach/reply-context.js';
import { verifyGmailDraftSnapshot } from '../../src/gmail/gmail-draft-preflight.js';

test('Follow-up preflight: exact parent headers are required in addition to recipient, copy and thread', async () => {
  const approved={ recipientEmail:'person@example.com',subject:'Hello',body:'Follow-up copy',threadId:'thread',parentMessageId:'<parent@example.com>' };
  const raw=buildResponseDraftMime('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    { ...approved,messageIdHeader:approved.parentMessageId,optOut:false,automatic:false },approved.body);
  const snapshot=(value:string)=>({ id:'draft',message:{ id:'message',threadId:'thread',labelIds:['DRAFT'],raw:value } });
  await verifyGmailDraftSnapshot('draft',approved,snapshot(raw));
  const mime=Buffer.from(raw,'base64url').toString();
  for (const changed of [mime.replace('In-Reply-To: <parent@example.com>','In-Reply-To: <other@example.com>'),
    mime.replace('References: <parent@example.com>','References: <other@example.com>'),
    mime.replace('References: <parent@example.com>\r\n',''), 'References: <parent@example.com>\r\n'+mime,
    'In-Reply-To: <parent@example.com>\r\n'+mime]) {
    await assert.rejects(verifyGmailDraftSnapshot('draft',approved,snapshot(Buffer.from(changed).toString('base64url'))));
  }
});
