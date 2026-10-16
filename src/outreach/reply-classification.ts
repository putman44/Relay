export const REPLY_CLASSES = ['Interested', 'Scheduling Intent', 'Question / Objection',
  'Referral / Wrong Contact', 'Not Interested', 'Opt Out', 'Out of Office', 'Unclear'] as const;
export const REPLY_ACTIONS = ['Draft Response', 'Schedule Discovery', 'Contact Referral',
  'Stop Outreach', 'Wait', 'Manual Review'] as const;
export type ReplyClassification = {
  classification: typeof REPLY_CLASSES[number];
  confidence: 'High' | 'Medium' | 'Low';
  summary: string;
  classificationNotes: string;
  nextAction: typeof REPLY_ACTIONS[number];
  shouldDraftResponse: boolean;
  responseGoal: string;
  suggestedResponse: string;
};
export const replyClassificationSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    classification: { type: 'string', enum: REPLY_CLASSES },
    confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] },
    summary: { type: 'string' }, classificationNotes: { type: 'string' },
    nextAction: { type: 'string', enum: REPLY_ACTIONS },
    shouldDraftResponse: { type: 'boolean' }, responseGoal: { type: 'string' }, suggestedResponse: { type: 'string' },
  },
  required: ['classification', 'confidence', 'summary', 'classificationNotes', 'nextAction',
    'shouldDraftResponse', 'responseGoal', 'suggestedResponse'],
};

export function validateReplyClassification(input: unknown): ReplyClassification {
  const value = typeof input === 'string' ? JSON.parse(input) as unknown : input;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reply classification object.');
  const record = value as Record<string, unknown>;
  const keys = replyClassificationSchema.required;
  if (Object.keys(record).length !== keys.length || keys.some(k => !Object.hasOwn(record, k))
    || Object.keys(record).some(k => !keys.includes(k))) throw new Error('Unexpected classification fields.');
  for (const key of ['summary', 'classificationNotes', 'responseGoal', 'suggestedResponse']) {
    if (typeof record[key] !== 'string' || (record[key] as string).includes('\0')
      || Buffer.byteLength(record[key] as string) > (key === 'suggestedResponse' ? 10000 : 2000)) {
      throw new Error('Classification text is invalid or exceeds its limit.');
    }
  }
  const c = value as ReplyClassification;
  if (!REPLY_CLASSES.includes(c.classification) || !['High', 'Medium', 'Low'].includes(c.confidence)
    || !REPLY_ACTIONS.includes(c.nextAction) || typeof c.shouldDraftResponse !== 'boolean' || !c.summary.trim()) {
    throw new Error('Invalid classification enum, summary, or draft decision.');
  }
  const allowed: Record<ReplyClassification['classification'], readonly string[]> = {
    Interested: ['Draft Response', 'Schedule Discovery', 'Manual Review'],
    'Scheduling Intent': ['Schedule Discovery', 'Manual Review'],
    'Question / Objection': ['Draft Response', 'Manual Review'],
    'Referral / Wrong Contact': ['Contact Referral', 'Manual Review'],
    'Not Interested': ['Stop Outreach'], 'Opt Out': ['Stop Outreach'],
    'Out of Office': ['Wait'], Unclear: ['Manual Review'],
  };
  if (!allowed[c.classification].includes(c.nextAction)) throw new Error('Classification/action mismatch.');
  if (c.shouldDraftResponse) {
    if (!['Interested', 'Scheduling Intent', 'Question / Objection'].includes(c.classification)
      || c.confidence === 'Low' || !['Draft Response', 'Schedule Discovery'].includes(c.nextAction)
      || !c.suggestedResponse.trim() || !c.responseGoal.trim()) throw new Error('Unsafe response draft decision.');
  } else if (c.suggestedResponse !== '' || c.responseGoal !== '') {
    throw new Error('No-draft decisions must not retain response copy.');
  }
  return { ...c };
}

export type ReplyClassifierInput = {
  companyName: string; originalSubject: string; originalBody: string;
  replySubject: string; replyBody: string;
};
export type ReplyClassifier = (input: ReplyClassifierInput) => Promise<unknown>;

export function noDraftDecision(classification: 'Opt Out' | 'Unclear', summary: string): ReplyClassification {
  return { classification, confidence: 'High', summary, classificationNotes: 'Conservative local safety policy; human review required.',
    nextAction: classification === 'Opt Out' ? 'Stop Outreach' : 'Manual Review',
    shouldDraftResponse: false, responseGoal: '', suggestedResponse: '' };
}
