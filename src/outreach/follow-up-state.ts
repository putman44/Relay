// src/outreach/follow-up-state.ts
import { createHash } from 'node:crypto';
import { decodeWords } from 'postal-mime';
import type { Pool, PoolClient } from 'pg';
import type { MessageDraft } from './message-drafts.js';
import type { GmailThread } from '../gmail/gmail-thread-reader.js';
import { findInboundReplies } from './reply-monitor.js';
import { followUpSchedule } from './follow-up-calendar.js';
import { responseBodyWithSignature } from './reply-context.js';

export type FollowUpDraft = MessageDraft & { follow_up_number: number | null; parent_outreach_draft_id: string | null };
export type FollowUpRequest = {
  id: string; prospect_id: string; parent_outreach_draft_id: string; follow_up_number: number;
  time_zone: string; due_date: string; recipient_email: string; subject: string; body: string;
  parent_sent_message_id: string; parent_rfc_message_id: string; history_version: string;
  status: string; gmail_draft_id: string | null; gmail_message_id: string | null; gmail_thread_id: string;
  approved_content_hash: string | null;
};
export async function followUpTransaction<T>(database: Pool, action: (client: PoolClient) => Promise<T>) {
  const client = await database.connect();
  try { await client.query('BEGIN'); const value = await action(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export function requireUuid(id: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid UUID.');
}
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function loadFollowUpState(client: PoolClient, prospectId: string, timeZone: string, now: Date, ownId?: string) {
  const p = (await client.query<{ contact_email: string | null; contact_name: string | null;
    primary_discovery_question: string | null; stage: string; cold_outreach_blocked: boolean; communication_opted_out: boolean }>(
    'SELECT * FROM prospects WHERE id=$1 FOR UPDATE', [prospectId])).rows[0];
  if (!p?.contact_email || p.stage !== 'outreach_sent' || p.cold_outreach_blocked || p.communication_opted_out) {
    throw new Error('Prospect is not eligible for cold follow-up.');
  }
  const drafts = (await client.query<FollowUpDraft>('SELECT * FROM message_drafts WHERE prospect_id=$1 ORDER BY id FOR UPDATE', [prospectId])).rows;
  if (drafts.some(d => d.draft_type === 'response' || (d.id !== ownId && ['sending','needs_reconciliation'].includes(d.send_status)))) {
    throw new Error('Existing response or unresolved send blocks cold follow-up.');
  }
  const blocked = await client.query(`SELECT 1 WHERE EXISTS (SELECT 1 FROM prospect_replies WHERE prospect_id=$1)
    OR EXISTS (SELECT 1 FROM reply_thread_checks c JOIN message_drafts d ON d.id=c.draft_id
      WHERE d.prospect_id=$1 AND c.status <> 'ok')`, [prospectId]);
  if (blocked.rowCount) throw new Error('Reply or unhealthy thread state blocks follow-up.');
  const initial = drafts.filter(d => d.draft_type === 'outreach' && d.send_status === 'sent');
  const outreach = initial[0];
  if (initial.length !== 1 || !outreach?.sent_at || !outreach.sent_message_id || !outreach.gmail_thread_id
    || outreach.recipient_email.toLowerCase() !== p.contact_email.toLowerCase()) throw new Error('Confirmed outreach identity is missing or ambiguous.');
  const followUps = drafts.filter(d => d.draft_type === 'follow_up');
  if (followUps.some(d => ![1,2].includes(d.follow_up_number!) || d.parent_outreach_draft_id !== outreach.id
    || d.gmail_thread_id !== outreach.gmail_thread_id || d.recipient_email.toLowerCase() !== p.contact_email!.toLowerCase()
    || (d.send_status === 'sent' ? !d.sent_message_id || !d.sent_at : !!d.sent_at || !!d.sent_message_id))) {
    throw new Error('Untracked or inconsistent follow-up history requires review.');
  }
  const sent = followUps.filter(d => d.send_status === 'sent').sort((a,b) => a.follow_up_number! - b.follow_up_number!);
  if (sent.length > 2 || sent.some((d,i) => d.follow_up_number !== i+1 || d.sent_at!.getTime() < (sent[i-1]?.sent_at ?? outreach.sent_at!).getTime())) {
    throw new Error('Follow-up sequence is inconsistent.');
  }
  const requests = (await client.query<FollowUpRequest>(`SELECT *,due_date::text AS due_date FROM follow_up_draft_requests
    WHERE prospect_id=$1 ORDER BY follow_up_number FOR UPDATE`, [prospectId])).rows;
  const schedule = followUpSchedule(outreach.sent_at, sent.map(d => d.sent_at!), timeZone, now);
  if (requests.some(r => r.time_zone !== schedule.timeZone || (r.id !== ownId && r.status !== 'created'))) {
    throw new Error('Follow-up zone or an unfinished request requires reconciliation.');
  }
  const version = fingerprint([p.contact_email,p.contact_name,p.primary_discovery_question,outreach.id,
    outreach.gmail_thread_id,outreach.sent_message_id,outreach.sent_at,outreach.subject,
    sent.map(d => [d.id,d.follow_up_number,d.sent_message_id,d.sent_at]),schedule.timeZone,schedule.dueDate]);
  return { prospectId, prospect: p, outreach, sent, drafts, requests, schedule, version };
}
export type FollowUpState = Awaited<ReturnType<typeof loadFollowUpState>>;
export function requireDue(state: FollowUpState) {
  if (!state.schedule.number) throw new Error('Two-follow-up cap reached.');
  if (!state.schedule.isDue) throw new Error('Follow-up is not due on the local calendar.');
}
export function verifyColdFollowUpThread(thread: GmailThread, state: FollowUpState): string {
  const threadId = state.outreach.gmail_thread_id!;
  if (findInboundReplies(thread, threadId, state.outreach.sent_message_id!).length) throw new Error('Inbound reply blocks cold follow-up.');
  const sent = thread.messages!.filter(m => m.labelIds?.includes('SENT')).sort((a,b) => Number(b.internalDate)-Number(a.internalDate) || b.id!.localeCompare(a.id!));
  const known = [state.outreach,...state.sent].map(d => d.sent_message_id);
  const expected = state.sent.at(-1)?.sent_message_id ?? state.outreach.sent_message_id;
  const initialMs = Number(thread.messages!.find(m => m.id === state.outreach.sent_message_id)!.internalDate);
  if (sent[0]?.id !== expected || known.some(id => !sent.some(m => m.id === id))
    || sent.some(m => Number(m.internalDate) >= initialMs && !known.includes(m.id!))) throw new Error('Untracked or changed outbound thread history.');
  const headers = sent[0].payload?.headers ?? [];
  const parent = headers.filter(h => h.name?.toLowerCase() === 'message-id');
  const subject = headers.filter(h => h.name?.toLowerCase() === 'subject');
  if (parent.length !== 1 || !parent[0]?.value || !/^<[^<>\s\x00-\x1f\x7f]+@[^<>\s\x00-\x1f\x7f]+>$/.test(parent[0].value)
    || parent[0].value.length > 250 || subject.length !== 1 || decodeWords(subject[0]?.value ?? '') !== state.outreach.subject) {
    throw new Error('Unsafe parent identity or changed thread subject.');
  }
  return parent[0].value;
}
export function followUpCopy(state: FollowUpState): string {
  const firstName = state.prospect.contact_name?.trim().split(/\s+/)[0];
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const question = state.prospect.primary_discovery_question || 'How do you currently handle and follow up with new customer inquiries?';
  const body = state.schedule.number === 1
    ? `${greeting}\n\nJust following up on my note below. The main thing I was hoping to understand was:\n\n${question}\n\nIf someone else handles that process, I’m happy to reach out to them instead.`
    : `${greeting}\n\nOne last follow-up from me. I’m still curious about:\n\n${question}\n\nIf this isn’t something you’re looking at right now, no worries at all.`;
  return responseBodyWithSignature(body);
}
export function approvalFingerprint(draft: FollowUpDraft, request: FollowUpRequest) {
  return fingerprint([draft.id,draft.prospect_id,draft.draft_type,draft.recipient_email,draft.subject,draft.body,
    draft.gmail_draft_id,draft.gmail_thread_id,draft.follow_up_number,draft.parent_outreach_draft_id,
    request.parent_sent_message_id,request.parent_rfc_message_id,request.history_version,request.time_zone,request.due_date]);
}
