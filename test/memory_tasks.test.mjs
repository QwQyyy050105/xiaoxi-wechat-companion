import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMemoryIntent,proposeMemory,approveMemory,rejectMemory,editMemory,deleteMemory,queryMemories} from '../src/memory_service.mjs';
import {parseTaskIntent,createReminder,approveReminder,editReminder,cancelReminder,queryTasks,recoverTasks,claimReminder,settleReminder} from '../src/task_service.mjs';

const now='2026-10-24T18:00:00+08:00';
const owner={isOwner:true};
const state=()=>({sessions:[{id:'abao',epoch:0,memoryEpoch:0},{id:'family',epoch:0,memoryEpoch:0}],memories:[],memoryCandidates:[],tasks:[]});
const memory=(s,overrides={})=>proposeMemory(s,{sessionId:'abao',text:'本群周六晚八点讨论方案',source:{eventId:'event1',originalText:'记住本群周六晚八点讨论方案'},expectedEpoch:0,expectedMemoryEpoch:0,now,...overrides});
const reminder=(s,overrides={})=>createReminder(s,{sessionId:'abao',targetId:'group_abao',text:'讨论方案',dueAt:'2026-10-25T20:00:00+08:00',timeZone:'Asia/Shanghai',actor:owner,now,...overrides});

test('memory commands are direct and explicit; unresolvable corrections require a choice',()=>{
  assert.equal(parseMemoryIntent('小汐，你记得什么？').type,'query');
  assert.deepEqual(parseMemoryIntent('小汐，记住本群周六讨论'),{type:'propose',action:'add',text:'本群周六讨论'});
  assert.equal(parseMemoryIntent('他说“小汐，记住本群周六讨论”'),null);
  assert.equal(parseMemoryIntent('小汐，别记住我的信息'),null);
  assert.equal(parseMemoryIntent('小汐，记错了，改成周日').code,'memory_id_required');
  assert.equal(parseMemoryIntent('小汐，修改记忆 abc-123 改成 本群周日讨论').memoryId,'abc-123');
});

test('group request becomes sourced candidate; member cannot approve',()=>{
  const s=state(), result=memory(s);
  assert.equal(result.code,'pending_approval'); assert.equal(s.memories.length,0);
  assert.equal(result.candidate.source.eventId,'event1'); assert.equal(result.candidate.source.senderId,null);
  assert.equal(approveMemory(s,result.candidate.id,{}).code,'owner_required');
  const approved=approveMemory(s,result.candidate.id,{actor:owner,now});
  assert.equal(approved.memory.text,'本群周六晚八点讨论方案'); assert.equal(s.sessions[0].memoryEpoch,0);
  assert.equal(queryMemories(s,{sessionId:'family'}).length,0);
});

test('memory candidate event id is idempotent within its session',()=>{
  const s=state(); const a=memory(s), b=memory(s);
  assert.equal(a.candidate.id,b.candidate.id); assert.equal(s.memoryCandidates.length,1);
  assert.equal(memory(s,{sessionId:'family'}).code,'pending_approval');
});

test('personal, hypothetical, hearsay and transient statements do not become shared facts',()=>{
  for(const text of ['我喜欢辣','我不吃辣','本群我喜欢辣','小明属狗','别人说小明喜欢A','假如本群周日讨论','今天好烦']) {
    const s=state(); assert.equal(memory(s,{text}).ok,false,text); assert.equal(s.memories.length,0); assert.equal(s.memoryCandidates.length,0);
  }
  const s=state(); assert.equal(memory(s,{text:'本群不在周六讨论，改在周日'}).ok,true);
});

test('memory edits preserve source versions, deletion leaves no text and stale extractors cannot resurrect',()=>{
  const s=state(), candidate=memory(s).candidate;
  const record=approveMemory(s,candidate.id,{actor:owner,now}).memory;
  const changed=editMemory(s,record.id,{actor:owner,text:'本群改在周日讨论',now});
  assert.equal(changed.memory.version,2); assert.equal(changed.memory.history[0].text,record.text);
  assert.equal(queryMemories(s,{sessionId:'abao'})[0].history,undefined);
  assert.equal(deleteMemory(s,record.id,{actor:owner,now}).ok,true);
  assert.equal(queryMemories(s,{sessionId:'abao'}).length,0);
  assert.equal(JSON.stringify(s).includes('本群周六晚八点讨论方案'),false);
  assert.equal(JSON.stringify(s).includes('本群改在周日讨论'),false);
  assert.equal(memory(s,{source:{eventId:'late'},expectedMemoryEpoch:0}).code,'stale_memory_epoch');
});

test('ordinary member changes require new candidates and cannot mutate approved records',()=>{
  const s=state(), saved=approveMemory(s,memory(s).candidate.id,{actor:owner,now}).memory;
  assert.equal(editMemory(s,saved.id,{text:'本群改在周日讨论'}).code,'owner_required');
  assert.equal(deleteMemory(s,saved.id,{}).code,'owner_required');
  const proposal=memory(s,{action:'edit',memoryId:saved.id,text:'本群改在周日讨论',source:{eventId:'edit1'},expectedMemoryEpoch:0});
  assert.equal(proposal.ok,true); assert.equal(queryMemories(s,{sessionId:'abao'})[0].text,saved.text);
  assert.equal(approveMemory(s,proposal.candidate.id,{actor:owner,now}).memory.text,'本群改在周日讨论');
});

test('private and another-group rows stay out of memory retrieval and candidate options',()=>{
  const s=state(); s.memories.push({id:'private',sessionId:'abao',scope:'personal',text:'私人记录'},
    {id:'hidden',sessionId:'abao',visibility:'private',text:'隐私记录'},
    {id:'owner',sessionId:'abao',scope:'session',ownerOnly:true,text:'主人记录'},
    {id:'pending',sessionId:'abao',status:'pending',text:'待确认记录'},
    {id:'other',sessionId:'family',text:'另一群'}, {id:'legacy',sessionId:'abao',text:'本群手工约定',source:'manual',createdAt:now});
  const rows=queryMemories(s,{sessionId:'abao'});
  assert.deepEqual(rows.map(x=>x.id),['legacy']); assert.equal(rows[0].source.kind,'legacy_owner');
  assert.equal(memory(s,{action:'delete',memoryId:'private'}).code,'memory_not_found');
  assert.equal(memory(s,{action:'delete',memoryId:'hidden'}).code,'memory_not_found');
  assert.equal(memory(s,{action:'delete',memoryId:'other'}).code,'memory_not_found');
  assert.equal(queryMemories(s,{sessionId:'abao',actor:owner})[0].source.senderId,null);
});

test('independent memory candidates can be approved sequentially, conflicting edits require fresh version',()=>{
  const s=state(), a=memory(s,{sender:{id:'memberA',evidence:'stable_id'}}).candidate;
  const b=memory(s,{text:'本群共同使用北京时间',source:{eventId:'event2'}}).candidate;
  assert.equal(a.source.senderId,'memberA');
  const saved=approveMemory(s,a.id,{actor:owner,now}).memory;
  assert.equal(approveMemory(s,b.id,{actor:owner,now}).ok,true);
  const c=memory(s,{action:'edit',memoryId:saved.id,text:'本群周日讨论',source:{eventId:'event3'}}).candidate;
  const d=memory(s,{action:'edit',memoryId:saved.id,text:'本群周一讨论',source:{eventId:'event4'}}).candidate;
  assert.equal(approveMemory(s,c.id,{actor:owner,now}).invalidateSession,true);
  assert.equal(approveMemory(s,d.id,{actor:owner,now}).code,'stale_version');
});

test('topic reset and memory replacement invalidate pending approvals',()=>{
  const s=state(), a=memory(s).candidate; s.sessions[0].epoch++;
  assert.equal(approveMemory(s,a.id,{actor:owner,now}).code,'stale_epoch');
  assert.equal(rejectMemory(s,a.id,{actor:owner,now}).ok,true);
  const s2=state(); const p=memory(s2).candidate; s2.sessions[0].memoryEpoch++;
  assert.equal(approveMemory(s2,p.id,{actor:owner,now}).code,'stale_memory_epoch');
});

test('task parsing uses exact calendar dates, keeps search query bounded, labels summaries',()=>{
  assert.deepEqual(parseTaskIntent('小汐，2026-10-25 20:00 提醒本群讨论方案'),{
    type:'reminder',dueAt:'2026-10-25T20:00+08:00',timeZone:'Asia/Shanghai',text:'讨论方案'});
  assert.equal(parseTaskIntent('小汐，明天晚上提醒我讨论').type,'clarify');
  assert.equal(parseTaskIntent('小汐，2026-02-30 20:00 提醒本群讨论').code,'invalid_datetime');
  assert.equal(parseTaskIntent('小汐，2026-10-25 20:00+09:00 提醒本群讨论').code,'invalid_datetime');
  assert.equal(parseTaskIntent('小汐，总结刚才讨论的两种方案').type,'summary');
  assert.equal(parseTaskIntent('小汐，搜索：Node 官方文档').query,'Node 官方文档');
  assert.equal(parseTaskIntent('小汐，搜索一下 Node 官方文档').query,'Node 官方文档');
  assert.equal(parseTaskIntent('他说小汐，取消提醒 abc'),null);
  assert.equal(parseTaskIntent('小汐，搜索 '+ 'a'.repeat(700)).query.length,500);
});

test('reminder validates dates/timezones and unknown identities can only propose',()=>{
  const s=state(); const proposed=reminder(s,{actor:{}});
  assert.equal(proposed.task.status,'proposed'); assert.equal(claimReminder(s,proposed.task.id,{now:'2026-10-25T20:00:00+08:00'}).ok,false);
  assert.equal(approveReminder(s,proposed.task.id,{}).code,'owner_required');
  assert.equal(approveReminder(s,proposed.task.id,{actor:owner,now}).task.status,'scheduled');
  for(const [change,code] of [[{dueAt:'2026-10-25 20:00'},'explicit_datetime_required'],
    [{dueAt:'2026-10-25T20:00:00+09:00'},'timezone_mismatch'],[{timeZone:'invalid'},'time_zone_required'],
    [{dueAt:'2026-10-23T20:00:00+08:00'},'time_not_future'],[{expectedEpoch:9},'stale_epoch']]) {
    assert.equal(reminder(state(),change).code,code);
  }
});

test('local owner can edit and cancel a scheduled reminder, cancelled work cannot be claimed',()=>{
  const s=state(), row=reminder(s).task;
  assert.equal(editReminder(s,row.id,{text:'坏修改',now}).code,'owner_required');
  assert.equal(editReminder(s,row.id,{actor:owner,text:'讨论更新后的方案',dueAt:'2026-10-26T20:00:00+08:00',now}).task.version,2);
  assert.equal(cancelReminder(s,row.id,{actor:owner,now}).ok,true);
  assert.equal(claimReminder(s,row.id,{now:'2026-10-26T20:00:00+08:00'}).code,'not_scheduled');
  assert.equal(queryTasks(s,{sessionId:'family'}).length,0);
});

test('claim is persisted state with an attempt id; duplicate or stale settlement cannot resend',()=>{
  const s=state(), row=reminder(s).task, due='2026-10-25T20:00:00+08:00';
  const first=claimReminder(s,row.id,{now:due}); assert.equal(first.ok,true); assert.ok(first.task.attemptId);
  assert.equal(claimReminder(s,row.id,{now:due}).code,'not_scheduled');
  assert.equal(settleReminder(s,row.id,{status:'local_echo',attemptId:'wrong',now:due}).code,'stale_attempt');
  const settled=settleReminder(s,row.id,{status:'local_echo',attemptId:first.task.attemptId,now:due});
  assert.equal(settled.task.reason,'local_echo_only');
  assert.equal(settleReminder(s,row.id,{status:'local_echo',attemptId:first.task.attemptId,now:due}).code,'not_claimed');
});

test('restart marks interrupted attempts unknown and expired scheduled work missed without replay',()=>{
  const s=state(), pending=reminder(s).task, claimed=reminder(s,{requestId:'claimed'}).task;
  claimReminder(s,claimed.id,{now:'2026-10-25T20:00:00+08:00'});
  const restored=JSON.parse(JSON.stringify(s)); recoverTasks(restored,{now:'2026-10-25T21:00:00+08:00'});
  assert.equal(restored.tasks.find(x=>x.id===pending.id).status,'missed');
  assert.equal(restored.tasks.find(x=>x.id===claimed.id).status,'unknown');
  assert.equal(claimReminder(restored,claimed.id,{now:'2026-10-25T21:00:00+08:00'}).code,'not_scheduled');
  assert.deepEqual(recoverTasks(restored,{now:'2026-10-26T21:00:00+08:00'}),[]);
});

test('lateness or deferral never creates an automatic retry schedule',()=>{
  const s=state(), row=reminder(s).task;
  assert.equal(claimReminder(s,row.id,{now}).code,'not_due');
  assert.equal(claimReminder(s,row.id,{now:'2026-10-25T20:02:00+08:00'}).code,'missed');
  const row2=reminder(s,{requestId:'deferred'}).task, claimed=claimReminder(s,row2.id,{now:'2026-10-25T20:00:00+08:00'});
  assert.equal(cancelReminder(s,row2.id,{actor:owner,now}).code,'task_already_committed');
  assert.equal(settleReminder(s,row2.id,{status:'deferred',attemptId:claimed.task.attemptId,now}).task.status,'not_sent');
});

test('request id creation is idempotent and returned rows cannot mutate stored state',()=>{
  const s=state(), a=reminder(s,{requestId:'a'}), b=reminder(s,{requestId:'a'});
  assert.equal(a.task.id,b.task.id); assert.equal(s.tasks.length,1);
  a.task.text='mutation'; queryTasks(s,{sessionId:'abao'})[0].status='cancelled';
  assert.equal(s.tasks[0].text,'讨论方案'); assert.equal(s.tasks[0].status,'scheduled');
});

test('reminders stay bound to their registered WeChat session target',()=>{
  const s=state(); s.targets=[{id:'group_abao'},{id:'group_family'}];
  Object.assign(s.sessions[0],{channel:'desktop_wechat',peerId:'group_abao'});
  assert.equal(reminder(s,{targetId:'missing'}).code,'target_not_found');
  assert.equal(reminder(s,{targetId:'group_family'}).code,'target_session_mismatch');
  const row=reminder(s).task;
  assert.equal(editReminder(s,row.id,{actor:owner,targetId:'group_family',now}).code,'target_session_mismatch');
});

test('approval cannot substitute a future timestamp just to bypass an expired candidate',()=>{
  const s=state(), row=reminder(s,{actor:{}}).task;
  assert.equal(approveReminder(s,row.id,{actor:owner,now:'2026-10-26T20:00:00+08:00',dueAt:'2026-10-30T20:00:00+08:00'}).code,'time_not_future');
  assert.equal(s.tasks[0].status,'proposed');
});
