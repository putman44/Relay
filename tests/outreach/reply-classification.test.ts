import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateReplyClassification, noDraftDecision } from '../../src/outreach/reply-classification.js';
import { replyDecision } from '../helpers/reply-fixtures.js';

test('Reply classification: object and JSON inputs take the same validation path', () => {
  assert.deepEqual(validateReplyClassification(replyDecision), replyDecision);
  assert.deepEqual(validateReplyClassification(JSON.stringify(replyDecision)), replyDecision);
  for (const input of [null, [], {}, { ...replyDecision, confidence: 'Unknown' }, { ...replyDecision, summary: 42 },
    { ...replyDecision, shouldDraftResponse: 'true' }, { ...replyDecision, recipientEmail: 'other@example.com' },
    { ...replyDecision, summary: ' ' }, { ...replyDecision, suggestedResponse: 'a'.repeat(10001) }]) {
    assert.throws(() => validateReplyClassification(input));
    assert.throws(() => validateReplyClassification(JSON.stringify(input)));
  }
  assert.throws(() => validateReplyClassification('```json\n{}\n```'));
});
test('Reply classification: no response for opt-outs, OOO, negative, unclear, referrals, or low confidence', () => {
  for (const classification of ['Opt Out', 'Not Interested', 'Out of Office', 'Unclear', 'Referral / Wrong Contact']) {
    assert.throws(() => validateReplyClassification({ ...replyDecision, classification }));
  }
  assert.throws(() => validateReplyClassification({ ...replyDecision, confidence: 'Low' }));
  assert.throws(() => validateReplyClassification({ ...replyDecision, shouldDraftResponse: false }));
  assert.throws(() => validateReplyClassification({ ...replyDecision, nextAction: 'Stop Outreach' }));
  assert.throws(() => validateReplyClassification({ ...replyDecision, suggestedResponse: '' }));
  assert.deepEqual(validateReplyClassification(noDraftDecision('Opt Out', 'Stop contact')), noDraftDecision('Opt Out', 'Stop contact'));
});
test('Reply classification: valid no-draft classes retain no response copy', () => {
  for (const [classification, nextAction] of [['Not Interested', 'Stop Outreach'], ['Out of Office', 'Wait'],
    ['Unclear', 'Manual Review'], ['Referral / Wrong Contact', 'Contact Referral']]) {
    const decision = { ...replyDecision, classification, nextAction, shouldDraftResponse: false, responseGoal: '', suggestedResponse: '' };
    assert.deepEqual(validateReplyClassification(decision), decision);
  }
});
