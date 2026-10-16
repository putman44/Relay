export const replyDecision = {
  classification: 'Interested', confidence: 'High', summary: 'Interested in learning more.',
  classificationNotes: '', nextAction: 'Draft Response', shouldDraftResponse: true,
  responseGoal: 'Answer the question.', suggestedResponse: 'Thanks for your interest. What would help most?',
};
export function rawReply(body = 'Sounds interesting. How does this work?', headers: string[] = []) {
  return Buffer.from([
    'From: Person <person@example.com>', 'To: owner@example.org', 'Subject: Re: Hello',
    'Message-ID: <reply@example.com>', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', ...headers, '', Buffer.from(body).toString('base64'), '',
  ].join('\r\n')).toString('base64url');
}
