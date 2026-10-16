import 'dotenv/config';
import { parseFollowUpArgs } from '../src/operator/follow-up-input.js';
import { assertLiveOutreachSendEnabled } from '../src/jobs/live-outreach-send-guard.js';

async function main() {
  const command = parseFollowUpArgs(process.argv.slice(2));
  if (command.action === 'send') assertLiveOutreachSendEnabled();
  const { db } = await import('../src/db.js');
  try {
    const { inspectFollowUp,createFollowUpDraft } = await import('../src/outreach/follow-up-creation.js');
    const { approveFollowUpDraft,sendApprovedFollowUp } = await import('../src/outreach/follow-up-send.js');
    let result;
    if (command.action === 'plan') result = await inspectFollowUp(command.prospectId,command.timeZone,db);
    else if (command.action === 'approve') result = await approveFollowUpDraft(command.draftId,db);
    else {
      const { createProductionGmailDraftCreator,createProductionGmailThreadReader } = await import('../src/gmail/gmail-runtime.js');
      const readThread = createProductionGmailThreadReader();
      if (command.action === 'draft') result = await createFollowUpDraft(command.prospectId,command.timeZone,
        { database:db,readThread,createGmailDraft:createProductionGmailDraftCreator() });
      else {
        const { createGmailApi,createGmailOAuthClient,loadGmailCredentials } = await import('../src/gmail/gmail-auth.js');
        result = await sendApprovedFollowUp(command.draftId,
          { database:db,readThread,gmail:createGmailApi(createGmailOAuthClient(loadGmailCredentials())) });
      }
    }
    console.log(JSON.stringify(result));
  } finally { await db.end(); }
}
main().catch(() => { console.error('Follow-up operation stopped; inspect durable request/draft/attempt state.'); process.exitCode=1; });
