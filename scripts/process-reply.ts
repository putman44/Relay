import 'dotenv/config';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--prospect'
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(args[1] ?? '')
    || args[2] !== '--confirm-create-response-draft') {
    throw new Error('Usage: --prospect <UUID> --confirm-create-response-draft');
  }
  const { db } = await import('../src/db.js');
  try {
    const { createProductionGmailDraftCreator, createProductionGmailThreadReader,
      createProductionGmailMessageReader } = await import('../src/gmail/gmail-runtime.js');
    const { createOpenAIReplyClassifier } = await import('../src/outreach/openai-reply-classifier.js');
    const { processLatestReply } = await import('../src/outreach/process-reply.js');
    const result = await processLatestReply(args[1]!, { database: db,
      readThread: createProductionGmailThreadReader(), readMessage: createProductionGmailMessageReader(),
      classify: createOpenAIReplyClassifier(), createGmailDraft: createProductionGmailDraftCreator() });
    console.log(JSON.stringify(result));
  } finally { await db.end(); }
}
main().catch(() => { console.error('Reply processing stopped; inspect reply_processing_requests before recovery.'); process.exitCode = 1; });
