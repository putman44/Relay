import 'dotenv/config';

async function main() {
  if (process.argv.slice(2).join(' ') !== '--confirm-record-replies') {
    throw new Error('Usage: npm run monitor:replies -- --confirm-record-replies');
  }
  const { db } = await import('../src/db.js');
  try {
    const { createProductionGmailThreadReader } = await import('../src/gmail/gmail-runtime.js');
    const { monitorReplies } = await import('../src/outreach/reply-monitor.js');
    const result = await monitorReplies(db, createProductionGmailThreadReader());
    console.log(JSON.stringify(result));
    if (result.errors || result.attentionRequired) process.exitCode = 1;
  } finally { await db.end(); }
}
main().catch(() => { console.error('Reply monitoring failed; inspect configuration and persisted thread checks.'); process.exitCode = 1; });
