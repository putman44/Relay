import 'dotenv/config';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { GmailDraftApi } from '../../src/gmail/gmail-draft-sender.js';
import type { GmailDraftReadApi } from '../../src/gmail/gmail-draft-preflight.js';
import { approveFollowUpDraft,sendApprovedFollowUp } from '../../src/outreach/follow-up-send.js';
import { createFollowUpDraft,inspectFollowUp } from '../../src/outreach/follow-up-creation.js';
import { monitorReplies } from '../../src/outreach/reply-monitor.js';

test('Follow-up pipeline: local-calendar drafting and approved-send safety', { skip:!process.env.RELAY_DRAFT_TEST_DATABASE_URL }, async t=>{
  const connectionString=process.env.RELAY_DRAFT_TEST_DATABASE_URL!;
  const schema=`follow_up_test_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({ connectionString });
  const database=new Pool({ connectionString,options:`-c search_path=${schema}` });
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async()=>{ await database.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end(); });
  const dir=new URL('../../migrations/',import.meta.url);
  for(const name of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await database.query(await readFile(new URL(name,dir),'utf8'));
  let clock=new Date('2026-10-05T17:00:00Z');
  let prospectId='',outreachId='',creates=0,sends=0,reads=0;
  const mailbox=new Map<string,{ raw:string;messageId:string }>();
  const seed=async()=>{
    await database.query('DELETE FROM prospects'); mailbox.clear(); creates=0;sends=0;reads=0;
    clock=new Date('2026-10-05T17:00:00Z'); prospectId=randomUUID();outreachId=randomUUID();
    await database.query(`INSERT INTO prospects (id,company_name,contact_email,contact_name,stage,primary_discovery_question)
      VALUES ($1,'Test','person@example.com','Casey Contact','outreach_sent','How are new inquiries handled?')`,[prospectId]);
    await database.query(`INSERT INTO message_drafts (id,prospect_id,recipient_email,subject,body,
      gmail_thread_id,send_status,review_status,sent_message_id,sent_at)
      VALUES ($1,$2,'person@example.com','Hello — café','Original','thread','sent','sent','initial','2026-10-01T16:00:00Z')`,[outreachId,prospectId]);
  };
  const readThread=async()=>{
    const rows=(await database.query(`SELECT sent_message_id,sent_at,subject FROM message_drafts
      WHERE prospect_id=$1 AND send_status='sent' ORDER BY sent_at`,[prospectId])).rows;
    return { id:'thread',messages:rows.map(row=>({ id:String(row.sent_message_id),threadId:'thread',internalDate:String(new Date(row.sent_at).getTime()),
      labelIds:['SENT'],payload:{ headers:[{ name:'Message-ID',value:`<${row.sent_message_id}@example.com>` },{ name:'Subject',value:row.subject }] } })) };
  };
  const inbound=()=>({ id:'inbound',threadId:'thread',internalDate:String(clock.getTime()),labelIds:['INBOX'],payload:{ headers:[] } });
  const createDeps=()=>({ database,readThread,now:()=>new Date(clock),createGmailDraft:async(raw:string,threadId?:string)=>{
    creates++;assert.equal(threadId,'thread'); const id=`gmail-${randomUUID()}`,messageId=`draft-message-${creates}`;
    mailbox.set(id,{ raw,messageId });return { draftId:id,messageId,threadId:'thread' };
  } });
  const api=():GmailDraftApi&GmailDraftReadApi=>({ users:{ drafts:{
    get:async request=>{ reads++;const draft=mailbox.get(request.id);assert.ok(draft);
      return { data:{ id:request.id,message:{ id:draft.messageId,threadId:'thread',labelIds:['DRAFT'],raw:draft.raw } } }; },
    send:async(request,options)=>{ sends++;assert.equal(options?.retry,false);assert.ok(request.requestBody.message?.raw);
      assert.equal(request.requestBody.message?.threadId,'thread');mailbox.delete(request.requestBody.id);
      return { data:{ id:`confirmed-${sends}`,threadId:'thread' } }; },
  } } });
  const sendDeps=()=>({ database,gmail:api(),readThread,now:()=>new Date(clock) });
  const create=async()=>createFollowUpDraft(prospectId,'America/Denver',createDeps());
  const ready=async()=>{const result=await create();await approveFollowUpDraft(result.draftId,database,clock);return result.draftId;};
  const draft=async(id:string)=>(await database.query('SELECT * FROM message_drafts WHERE id=$1',[id])).rows[0];
  const request=async(id:string)=>(await database.query('SELECT *,due_date::text AS due_date FROM follow_up_draft_requests WHERE id=$1',[id])).rows[0];
  const attempt=async(id:string)=>(await database.query('SELECT * FROM follow_up_send_attempts WHERE draft_id=$1',[id])).rows[0];
  const recordReply=async()=>{
    await database.query(`INSERT INTO prospect_replies (prospect_id,gmail_message_id,gmail_thread_id,received_at,sender,subject,snippet)
      VALUES ($1,'inbound','thread',$2,'person@example.com','Re: Hello','Reply')`,[prospectId,clock]);
    await database.query("UPDATE prospects SET cold_outreach_blocked=true,stage='replied' WHERE id=$1",[prospectId]);
  };

  await t.test('first and second touches retain copy, require approval, advance dates only after confirmed sends, then cap',async()=>{
    await seed();assert.equal((await inspectFollowUp(prospectId,'America/Denver',database,clock)).dueDate,'2026-10-05');
    const first=await create();assert.equal(first.number,1);assert.equal((await draft(first.draftId)).review_status,'needs_review');
    assert.match((await draft(first.draftId)).body,/Hi Casey,/);assert.match((await draft(first.draftId)).body,/Just following up/);
    assert.match((await draft(first.draftId)).body,/How are new inquiries handled\?/);assert.match((await draft(first.draftId)).body,/Taylor Putman/);
    assert.equal((await inspectFollowUp(prospectId,'America/Denver',database,clock)).confirmedFollowUps,0);
    await approveFollowUpDraft(first.draftId,database,clock);await sendApprovedFollowUp(first.draftId,sendDeps());
    assert.equal((await draft(first.draftId)).send_status,'sent');assert.equal((await attempt(first.draftId)).status,'sent');
    const next=await inspectFollowUp(prospectId,'America/Denver',database,clock);assert.equal(next.dueDate,'2026-10-10');assert.equal(next.isDue,false);
    clock=new Date('2026-10-10T06:00:00Z');const second=await ready();assert.match((await draft(second)).body,/One last follow-up/);
    assert.equal((await request(second)).parent_sent_message_id,'confirmed-1');await sendApprovedFollowUp(second,sendDeps());
    const capped=await inspectFollowUp(prospectId,'America/Denver',database,clock);assert.equal(capped.number,null);assert.equal(capped.confirmedFollowUps,2);
    await assert.rejects(create());assert.equal(creates,2);assert.equal(sends,2);
    assert.equal((await database.query('SELECT count(*) FROM outreach_jobs')).rows[0].count,'0');
  });
  await t.test('not-due creation and non-approved sending never contact Gmail',async()=>{
    await seed();clock=new Date('2026-10-05T05:59:59Z');await assert.rejects(create());assert.equal(creates,0);
    clock=new Date('2026-10-05T17:00:00Z');const first=await create();await assert.rejects(sendApprovedFollowUp(first.draftId,sendDeps()));
    assert.equal(reads,0);assert.equal(sends,0);assert.equal(await attempt(first.draftId),undefined);
  });
  await t.test('concurrent creation and sending each allow one external mutation',async()=>{
    await seed();const created=await Promise.allSettled([create(),create()]);assert.equal(created.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(creates,1);const id=(created.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof create>>>).value.draftId;
    await approveFollowUpDraft(id,database,clock);
    const sent=await Promise.allSettled([sendApprovedFollowUp(id,sendDeps()),sendApprovedFollowUp(id,sendDeps())]);
    assert.equal(sent.filter(r=>r.status==='fulfilled').length,1);assert.equal(sends,1);await assert.rejects(sendApprovedFollowUp(id,sendDeps()));
  });
  await t.test('unrecorded inbound, unknown sent mail and unsafe parent headers block creation',async()=>{
    for(const mode of ['reply','unknown-sent','parent','subject']){
      await seed();await assert.rejects(createFollowUpDraft(prospectId,'America/Denver',{ ...createDeps(),readThread:async()=>{
        const thread=await readThread();
        if(mode==='reply')thread.messages.push(inbound());
        if(mode==='unknown-sent')thread.messages.push({ ...inbound(),id:'manual-send',labelIds:['SENT'] });
        if(mode==='parent')thread.messages[0]!.payload.headers[0]!.value='<unsafe>\r\nBcc: other@example.com';
        if(mode==='subject')thread.messages[0]!.payload.headers[1]!.value='Changed';
        return thread;
      } }));assert.equal(creates,0);
    }
  });
  await t.test('opt-outs, recorded replies, suppression, unhealthy checks, responses and uncertainty block before Gmail',async()=>{
    for(const mode of ['opt-out','reply','blocked','error','response','uncertain']){
      await seed();
      if(mode==='opt-out')await database.query('UPDATE prospects SET communication_opted_out=true WHERE id=$1',[prospectId]);
      if(mode==='reply')await recordReply();
      if(mode==='blocked')await database.query('UPDATE prospects SET cold_outreach_blocked=true WHERE id=$1',[prospectId]);
      if(mode==='error')await database.query("INSERT INTO reply_thread_checks (draft_id,status) VALUES ($1,'error')",[outreachId]);
      if(mode==='response'||mode==='uncertain')await database.query(`INSERT INTO message_drafts
        (prospect_id,draft_type,recipient_email,subject,body,send_status) VALUES ($1,$2,'person@example.com','Other','Body',$3)`,
      [prospectId,mode==='response'?'response':'outreach',mode==='uncertain'?'needs_reconciliation':'pending']);
      await assert.rejects(create());assert.equal(creates,0);
    }
  });
  await t.test('edited Gmail body or parent blocks before send and marks review without claiming an uncertain send',async()=>{
    for(const mode of ['body','parent']){
      await seed();const id=await ready(),row=await draft(id),stored=mailbox.get(row.gmail_draft_id)!;
      if(mode==='parent')stored.raw=Buffer.from(Buffer.from(stored.raw,'base64url').toString().replace('In-Reply-To: <initial@example.com>','In-Reply-To: <other@example.com>')).toString('base64url');
      else {const mime=Buffer.from(stored.raw,'base64url').toString();stored.raw=Buffer.from(mime.split('\r\n\r\n')[0]+'\r\n\r\n'+Buffer.from('Changed copy').toString('base64')).toString('base64url');}
      await assert.rejects(sendApprovedFollowUp(id,sendDeps()));assert.equal(sends,0);
      assert.equal((await draft(id)).send_status,'pending');assert.equal((await draft(id)).review_status,'needs_edit');
      assert.equal((await attempt(id)).status,'blocked');assert.equal((await draft(id)).reconciliation_at,null);
    }
  });
  await t.test('fresh inbound or unavailable live thread stops approved follow-up even before the reply monitor catches it',async()=>{
    for(const mode of ['reply','unavailable']){
      await seed();const id=await ready();await assert.rejects(sendApprovedFollowUp(id,{ ...sendDeps(),readThread:async()=>{
        if(mode==='unavailable')throw new Error('thread unavailable');const thread=await readThread();thread.messages.push(inbound());return thread;
      } }));assert.equal(sends,0);assert.equal((await attempt(id)).status,'blocked');
    }
  });
  await t.test('approval binds content even when both draft and creation copy are edited consistently',async()=>{
    await seed();const id=await ready();await database.query("UPDATE message_drafts SET body='Changed' WHERE id=$1",[id]);
    await database.query("UPDATE follow_up_draft_requests SET body='Changed' WHERE id=$1",[id]);
    await assert.rejects(sendApprovedFollowUp(id,sendDeps()));assert.equal(reads,0);assert.equal(sends,0);
  });
  await t.test('revoked approval or a recorded reply during preflight is rechecked before sending',async()=>{
    for(const mode of ['approval','reply']){
      await seed();const id=await ready(),gmail=api(),originalGet=gmail.users.drafts.get;
      gmail.users.drafts.get=async req=>{const result=await originalGet(req);
        if(mode==='approval')await database.query("UPDATE message_drafts SET review_status='rejected' WHERE id=$1",[id]);else await recordReply();
        return result;
      };
      await assert.rejects(sendApprovedFollowUp(id,{ ...sendDeps(),gmail }));assert.equal(sends,0);assert.equal((await attempt(id)).status,'blocked');
      if(mode==='approval'){assert.equal((await draft(id)).review_status,'rejected');assert.equal((await draft(id)).send_status,'sending');}
    }
  });
  await t.test('the sent MIME is the inspected snapshot even if the mailbox changes after retrieval',async()=>{
    await seed();const id=await ready(),gmail=api(),originalGet=gmail.users.drafts.get,originalSend=gmail.users.drafts.send;
    let inspected='';gmail.users.drafts.get=async req=>{const result=await originalGet(req);inspected=result.data.message!.raw!;
      mailbox.get(req.id)!.raw='changed-after-read';return result;};
    gmail.users.drafts.send=async(req,opts)=>{assert.equal(req.requestBody.message?.raw,inspected);return originalSend(req,opts);};
    await sendApprovedFollowUp(id,{ ...sendDeps(),gmail });assert.equal(sends,1);
  });
  await t.test('lost, partial and wrong-thread Gmail send results are never retried and retain available evidence',async()=>{
    for(const mode of ['lost','partial','wrong-thread','reused-id']){
      await seed();const id=await ready(),gmail=api();gmail.users.drafts.send=async()=>{sends++;
        if(mode==='lost')throw new Error('lost response');return { data:{ id:mode==='reused-id'?'initial':'maybe-sent',
          ...(mode==='wrong-thread'?{threadId:'wrong-thread'}:mode==='reused-id'?{threadId:'thread'}:{}) } };};
      await assert.rejects(sendApprovedFollowUp(id,{ ...sendDeps(),gmail }));await assert.rejects(sendApprovedFollowUp(id,sendDeps()));
      assert.equal(sends,1);assert.equal((await draft(id)).send_status,'needs_reconciliation');assert.equal((await attempt(id)).status,'needs_reconciliation');
      if(mode!=='lost')assert.equal((await attempt(id)).sent_message_id,mode==='reused-id'?'initial':'maybe-sent');
      assert.equal((await database.query('SELECT stage FROM prospects')).rows[0].stage,'send_reconciliation');
    }
  });
  await t.test('a reply arriving during the send preserves confirmed send evidence and reply suppression',async()=>{
    await seed();const id=await ready(),gmail=api(),originalSend=gmail.users.drafts.send;
    gmail.users.drafts.send=async(req,opts)=>{await recordReply();return originalSend(req,opts);};
    await sendApprovedFollowUp(id,{ ...sendDeps(),gmail });assert.equal((await draft(id)).send_status,'sent');
    const p=(await database.query('SELECT * FROM prospects')).rows[0];assert.equal(p.stage,'replied');assert.equal(p.cold_outreach_blocked,true);
  });
  await t.test('database failure after confirmed Gmail send records IDs for reconciliation',async()=>{
    await seed();const id=await ready();
    await database.query(`CREATE FUNCTION block_confirmed_follow_up() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.send_status='sent' AND NEW.draft_type='follow_up' THEN RAISE EXCEPTION 'simulated finalization failure'; END IF; RETURN NEW; END $$`);
    await database.query('CREATE TRIGGER fail_follow_up_finalization BEFORE UPDATE ON message_drafts FOR EACH ROW EXECUTE FUNCTION block_confirmed_follow_up()');
    try{await assert.rejects(sendApprovedFollowUp(id,sendDeps()));assert.equal((await attempt(id)).status,'needs_reconciliation');
      assert.equal((await attempt(id)).sent_message_id,'confirmed-1');assert.equal((await draft(id)).send_status,'needs_reconciliation');}
    finally{await database.query('DROP TRIGGER fail_follow_up_finalization ON message_drafts');await database.query('DROP FUNCTION block_confirmed_follow_up()');}
  });
  await t.test('uncertain creation or a reply arriving during creation keeps returned IDs and prevents duplicate drafts',async()=>{
    for(const mode of ['lost','wrong-thread','reply']){
      await seed();await assert.rejects(createFollowUpDraft(prospectId,'America/Denver',{ ...createDeps(),createGmailDraft:async()=>{
        creates++;if(mode==='lost')throw new Error('lost draft response');if(mode==='reply')await recordReply();
        return { draftId:'external-draft',messageId:'external-message',threadId:mode==='wrong-thread'?'wrong-thread':'thread' };
      } }));assert.equal((await database.query('SELECT status FROM follow_up_draft_requests')).rows[0].status,'needs_reconciliation');
      if(mode!=='lost')assert.equal((await database.query('SELECT gmail_draft_id FROM follow_up_draft_requests')).rows[0].gmail_draft_id,'external-draft');
      await assert.rejects(create());assert.equal(creates,1);
    }
  });
  await t.test('follow-up zone changes and legacy/unsequenced history cannot bypass timing or caps',async()=>{
    await seed();await create();await assert.rejects(createFollowUpDraft(prospectId,'UTC',createDeps()));
    await seed();await database.query(`INSERT INTO message_drafts (prospect_id,draft_type,recipient_email,subject,body)
      VALUES ($1,'follow_up','person@example.com','Legacy','Unknown history')`,[prospectId]);await assert.rejects(create());assert.equal(creates,0);
  });
  await t.test('reply monitoring revokes pending follow-up approval without rewriting send evidence',async()=>{
    await seed();const id=await ready();await monitorReplies(database,async()=>{const thread=await readThread();thread.messages.push(inbound());return thread;});
    assert.equal((await draft(id)).review_status,'rejected');assert.equal((await draft(id)).send_status,'pending');
    await assert.rejects(sendApprovedFollowUp(id,sendDeps()));assert.equal(sends,0);
  });
  await t.test('UTF-8 encoded parent subjects are decoded before thread matching',async()=>{
    await seed();const result=await createFollowUpDraft(prospectId,'America/Denver',{ ...createDeps(),readThread:async()=>{
      const thread=await readThread();thread.messages[0]!.payload.headers[1]!.value=`=?UTF-8?B?${Buffer.from('Hello — café').toString('base64')}?=`;return thread;
    } });assert.equal((await draft(result.draftId)).subject,'Hello — café');
  });
  await t.test('database outages after creation or send retain duplicate-blocking reservations',async()=>{
    for(const mode of ['create','send']){
      await seed();let offline=false;
      const unavailable=new Proxy(database,{get(target,key){
        if(key==='connect')return async()=>{if(offline)throw new Error('offline');return target.connect();};
        if(key==='query')return async(...args:unknown[])=>{if(offline)throw new Error('offline');return Reflect.apply(target.query,target,args);};
        return Reflect.get(target,key);
      }});
      if(mode==='create'){
        await assert.rejects(createFollowUpDraft(prospectId,'America/Denver',{...createDeps(),database:unavailable,createGmailDraft:async()=>{
          creates++;offline=true;return {draftId:'unrecorded-draft',messageId:'unrecorded-message',threadId:'thread'};
        }}));
        assert.equal((await database.query('SELECT status FROM follow_up_draft_requests')).rows[0].status,'creating');await assert.rejects(create());assert.equal(creates,1);
      }else{
        const id=await ready(),gmail=api(),originalSend=gmail.users.drafts.send;
        gmail.users.drafts.send=async(req,opts)=>{const result=await originalSend(req,opts);offline=true;return result;};
        await assert.rejects(sendApprovedFollowUp(id,{...sendDeps(),database:unavailable,gmail}));
        assert.equal((await draft(id)).send_status,'sending');assert.equal((await attempt(id)).status,'invoking');
        await assert.rejects(sendApprovedFollowUp(id,sendDeps()));assert.equal(sends,1);
      }
    }
  });
  await t.test('lost final commit acknowledgement cannot downgrade a confirmed follow-up or enable retry',async()=>{
    await seed();const id=await ready();let commits=0;
    const lostAck=new Proxy(database,{get(target,key){
      if(key==='query')return target.query.bind(target);
      if(key==='connect')return async()=>{const client=await target.connect();return new Proxy(client,{get(connection,property){
        if(property==='query')return async(...args:unknown[])=>{const result=await Reflect.apply(connection.query,connection,args);
          if(args[0]==='COMMIT'&&++commits===3)throw new Error('lost commit acknowledgement');return result;};
        const value=Reflect.get(connection,property);return typeof value==='function'?value.bind(connection):value;
      }});};return Reflect.get(target,key);
    }});
    await assert.rejects(sendApprovedFollowUp(id,{...sendDeps(),database:lostAck}));
    assert.equal((await draft(id)).send_status,'sent');assert.equal((await attempt(id)).status,'sent');
    assert.equal((await attempt(id)).sent_message_id,'confirmed-1');await assert.rejects(sendApprovedFollowUp(id,sendDeps()));assert.equal(sends,1);
  });
});
