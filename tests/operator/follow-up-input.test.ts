import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseFollowUpArgs } from '../../src/operator/follow-up-input.js';

const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
test('Follow-up CLI: explicit draft/approval/send intent and UUID/zone validation', () => {
  assert.deepEqual(parseFollowUpArgs(['plan','--prospect',id,'--time-zone','America/Denver']),
    { action:'plan',prospectId:id,timeZone:'America/Denver' });
  assert.equal(parseFollowUpArgs(['draft','--prospect',id,'--time-zone','America/Denver','--confirm-create-draft']).action,'draft');
  assert.equal(parseFollowUpArgs(['approve','--draft',id,'--confirm-approve']).action,'approve');
  assert.equal(parseFollowUpArgs(['send','--draft',id,'--confirm-send']).action,'send');
  for (const args of [[],['send','--draft',id],['approve','--draft',id],['send','--draft','bad','--confirm-send'],
    ['draft','--prospect',id,'--time-zone','America/Denver'],['plan','--prospect',id,'--time-zone','Bad/Zone'],
    ['send','--draft',id,'--confirm-send','--extra']]) assert.throws(() => parseFollowUpArgs(args));
});
test('Follow-up CLI: live-send gate rejects before loading database or Gmail', () => {
  const result = spawnSync(process.execPath,['--import','tsx','scripts/follow-up.ts','send','--draft',id,'--confirm-send'],
    { encoding:'utf8',timeout:5000,env:{ ...process.env,RELAY_ENABLE_LIVE_OUTREACH_SEND:'false',DATABASE_URL:'invalid',GOOGLE_REFRESH_TOKEN:'' } });
  assert.equal(result.status,1); assert.match(result.stderr,/Follow-up operation stopped/);
});
