import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {getAuthorizedWechatScopes} from '../src/conversation_scope.mjs';
import {queryReminderReceipt as read} from '../src/reminder_receipt.mjs';
import {deployment} from '../src/deployment_config.mjs';
const account=deployment.account.displayName;
const [first,second]=getAuthorizedWechatScopes();
const created='2026-01-02T10:02:10+08:00', due='2026-01-02T10:12:10+08:00';
const query={target:first.id,text:'取文件',from:'2026-01-02T10:02:00+08:00',until:'2026-01-02T10:03:00+08:00'};

function fixture() {
  return {version:2,targets:[first,second],sessions:[first,second].map((g,i)=>({
    id:'session'+i,channel:'desktop_wechat',peerId:g.id,title:g.name,accountId:account})),
    tasks:[{id:'task1',targetId:first.id,sessionId:'session0',kind:'reminder',text:'取文件',createdAt:created,
      dueAt:due,status:'proposed',source:{kind:'group_candidate',eventId:'event1'}}],
    inbox:[{id:'in1',sessionId:'session0',event:{sourceKey:'event1',get text(){throw Error('read inbox text');}}}],
    outbox:[{id:'out1',sessionId:'session0',kind:'reply',status:'local_echo',requestIds:['in1'],text:'北京时间 2026年1月2日 10:12:10，提醒本群「取文件」'}]};
}
test('proposed receipt uses the incoming ID to match the acknowledgement and redacts its body',()=>{
  const result=read(fixture(),query);
  assert.equal(result.pendingApproval,true);assert.equal(result.approvalRecorded,false);
  assert.deepEqual(result.acknowledgement,{match:'request_id',containsTime:true,containsTaskText:true,receipts:['local_echo']});
  assert.equal(result.execution.localEcho,false);assert.equal(JSON.stringify(result).includes(query.text),false);
});
test('missing exact text and same-name reminders outside the creation window do not match',()=>{
  const state=fixture();
  assert.equal(read(state,{...query,text:'文件'}).result,'not_found');
  state.tasks[0].createdAt=query.until;assert.equal(read(state,query).result,'not_found');
});
test('other groups and unapproved targets cannot contribute tasks, acknowledgements or receipts',()=>{
  const state=fixture();
  state.outbox[0].sessionId='session1';state.outbox.push({sessionId:'session1',kind:'reminder',taskId:'task1',status:'local_echo'});
  const result=read(state,query);assert.equal(result.acknowledgement.match,'not_linked');assert.equal(result.execution.localEcho,false);
  assert.equal(read(state,{...query,target:second.id}).result,'not_found');
  assert.throws(()=>read(state,{...query,target:'unapproved-target'}),/target_not_authorized/);
});
test('same text and time twice reports ambiguity and leaks neither record',()=>{
  const state=fixture();state.tasks.push({...state.tasks[0],id:'task2'});
  assert.deepEqual(read(state,query),{result:'ambiguous',count:2});
});
test('approved, claimed and unknown delivery are distinct from confirmed local echo',()=>{
  const state=fixture(),task=state.tasks[0];
  Object.assign(task,{approvedAt:created,status:'scheduled',attemptId:'new'});
  assert.equal(read(state,query).approvalRecorded,true);
  for(const status of ['claimed','unknown','not_sent','missed']){task.status=status;assert.equal(read(state,query).execution.localEcho,false);}
  state.outbox.push({sessionId:'session0',kind:'reminder',taskId:task.id,attemptId:'old',status:'local_echo'});
  assert.equal(read(state,query).execution.localEcho,false);
  task.status='local_echo';state.outbox.push({sessionId:'session0',kind:'reminder',taskId:task.id,attemptId:'new',status:'local_echo'});
  assert.deepEqual(read(state,query).execution.receipts,['local_echo']);
});
test('initial acknowledgement can omit the time or text and cannot be inferred from a different request',()=>{
  const state=fixture();state.outbox[0].text='我知道了';
  const result=read(state,query);assert.equal(result.acknowledgement.containsTime,false);assert.equal(result.acknowledgement.containsTaskText,false);
  state.outbox[0].requestIds=['another'];assert.equal(read(state,query).acknowledgement.match,'not_linked');
});
test('invalid time and duplicate group mapping fail closed',()=>{
  const state=fixture();assert.throws(()=>read(state,{...query,from:'10:00'}),/explicit_time_window_required/);
  state.targets.push({...first});assert.throws(()=>read(state,query),/session_binding_unavailable/);
});
test('opening the existing store only decodes it and never changes the stored bytes',t=>{
  const dir=fs.mkdtempSync(path.resolve('temp','reminder_receipt_'));
  t.after(()=>{fs.unlinkSync(path.join(dir,'fixture'));fs.rmdirSync(dir);});
  const state=fixture();state.inbox[0].event={sourceKey:'event1'};
  const file=path.join(dir,'fixture'),bytes=Buffer.from(JSON.stringify(state));
  fs.writeFileSync(file,bytes);
  const store=new Store(file,{decode:b=>b.toString()});
  assert.equal(read(store.value,query).result,'matched');assert.deepEqual(fs.readFileSync(file),bytes);
});
