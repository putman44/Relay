import PostalMime, { addressParser } from 'postal-mime';
import type { GmailRawMessage } from '../gmail/gmail-message-reader.js';
import { buildOutreachDraftMime, validateOutreachDraftContent } from './outreach-draft-content.js';

export type ReplyContext = {
  recipientEmail: string; subject: string; body: string; messageIdHeader: string;
  optOut: boolean; automatic: boolean;
};

// Preserve the authored plain-text signature from the n8n response workflow.
export function responseBodyWithSignature(proposedBody: string): string {
  return `${proposedBody}\n\nThanks,\n\nTaylor Putman\nFounder & Developer\nDev by Taylor\nSoftware • Automation • Systems\ndevbytaylor.com`;
}

export async function extractReplyContext(message: GmailRawMessage, messageId: string,
  threadId: string, contactEmail: string): Promise<ReplyContext> {
  if (message.id !== messageId || message.threadId !== threadId || message.labelIds?.some(l => ['SENT', 'DRAFT'].includes(l))
    || !message.raw || message.raw.length > 350000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(message.raw)) {
    throw new Error('Inbound message identity or raw MIME is invalid.');
  }
  const bytes = Buffer.from(message.raw, 'base64url');
  if (bytes.toString('base64url') !== message.raw.replace(/=+$/, '')) throw new Error('Invalid inbound MIME encoding.');
  const email = await PostalMime.parse(bytes, { maxPartCount: 100, maxNestingDepth: 20,
    maxRfc822NestingDepth: 0, forceRfc822Attachments: true });
  const header = (name: string) => email.headers.filter(h => h.key === name);
  const fromAddresses = addressParser(header('from')[0]?.value ?? '');
  if (header('from').length !== 1 || header('reply-to').length > 1 || header('subject').length !== 1
    || header('message-id').length !== 1 || header('auto-submitted').length > 1
    || fromAddresses.length !== 1 || !fromAddresses[0]?.address
    || !email.from?.address || !email.subject?.trim() || !email.text?.trim()
    || email.attachments.length > 0 || Buffer.byteLength(email.text) > 50000) throw new Error('Reply needs manual MIME/body review.');
  const replyTo = email.replyTo;
  const recipient = replyTo ? replyTo[0] : email.from;
  if ((replyTo && replyTo.length !== 1) || !recipient || !('address' in recipient) || !recipient.address
    || recipient.address.toLowerCase() !== contactEmail.toLowerCase()
    || email.from.address.toLowerCase() !== contactEmail.toLowerCase()) {
    throw new Error('Reply routing differs from the known contact; manual review required.');
  }
  const msgId = email.messageId;
  if (!msgId || !/^<[^<>\s\x00-\x1f\x7f]+@[^<>\s\x00-\x1f\x7f]+>$/.test(msgId) || msgId.length > 250) {
    throw new Error('Reply Message-ID is unsafe or missing.');
  }
  validateOutreachDraftContent({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    prospectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', recipientEmail: recipient.address,
    subject: email.subject, body: email.text });
  const automatic = header('auto-submitted').some(h => h.value.trim().toLowerCase() !== 'no')
    || header('precedence').some(h => /^(bulk|list|junk)$/i.test(h.value.trim()))
    || email.from.address.toLowerCase().startsWith('mailer-daemon@');
  // Deliberately conservative, including quoted copy. This is not a complete
  // natural-language opt-out detector; model classification and review still apply.
  const optOut = /\b(unsubscribe|remove me|do not (?:email|contact)|don['’]t (?:email|contact)|stop (?:emailing|contacting))\b/i.test(email.text);
  return { recipientEmail: recipient.address, subject: email.subject, body: email.text,
    messageIdHeader: msgId, optOut, automatic };
}

export function buildResponseDraftMime(requestId: string, prospectId: string, context: ReplyContext, body: string) {
  if (!/^<[^<>\s\x00-\x1f\x7f]+@[^<>\s\x00-\x1f\x7f]+>$/.test(context.messageIdHeader)
    || context.messageIdHeader.length > 250) throw new Error('Unsafe response parent Message-ID.');
  const raw = buildOutreachDraftMime({ requestId, prospectId, recipientEmail: context.recipientEmail,
    subject: context.subject, body });
  // References intentionally contains only the exact parent, avoiding unsafe or
  // excessively long user-supplied reference chains. Subject is preserved.
  const mime = Buffer.from(raw, 'base64url').toString('utf8').replace('<relay-outreach-', '<relay-response-');
  return Buffer.from(`In-Reply-To: ${context.messageIdHeader}\r\nReferences: ${context.messageIdHeader}\r\n${mime}`)
    .toString('base64url');
}
