import test from 'node:test';import assert from 'node:assert/strict';
import {PublicLookupConversation} from '../src/public_lookup_conversation.mjs';
function fixture(){let now=10000;const logic=new PublicLookupConversation({nowMs:()=>now}),messages=[];
  const add=(id,text,sender={evidence:'unknown'})=>{const r={id,sourceKey:id,role:'user',observationMode:'live',generation:0,receivedAt:now,text,sender};messages.push(r);return r;};
  const plan=request=>logic.plan({sessionId:'s',request,snapshot:{sessionId:'s',generation:0,messages},epoch:0});
  const deliver=(request,text)=>{const out={id:'bot_'+request.id,text,epoch:0,contextGeneration:0};logic.noteDelivery('s',request,out,{status:'local_echo'});messages.push({...out,sourceKey:out.id,role:'assistant',deliveryStatus:'local_echo',generation:0});};
  return {logic,messages,add,plan,deliver,advance:ms=>now+=ms};
}
test('the reported ranking request and parameter answer complete one public lookup',()=>{
  const f=fixture(),first=f.add('1','小汐查看一下互联网十大企业'),question=f.plan(first);
  assert.equal(question.kind,'clarification');assert.match(question.text,/国内.*全球.*市值/);f.deliver(first,question.text);
  const next=f.plan(f.add('2','国内吧，市值'));assert.equal(next.kind,'search');assert.match(next.query,/中国上市互联网企业.*市值.*前十/);
});
test('complete scope queries skip clarification and partial answers ask only the missing detail',()=>{
  const f=fixture();assert.equal(f.plan(f.add('1','查询全球互联网企业市值排名前十')).kind,'search');
  const first=f.add('2','查一下互联网十大企业'),question=f.plan(first);f.deliver(first,question.text);
  const partial=f.add('3','国内吧'),next=f.plan(partial);assert.equal(next.text,'按市值还是营收？');f.deliver(partial,next.text);
  const revenue=f.plan(f.add('4','按营收'));assert.equal(revenue.kind,'search');assert.ok(!revenue.query.includes('上市'));
});
test('unconfirmed, expired, separated and different-member replies cannot inherit a lookup slot',()=>{
  for(const mode of ['unconfirmed','expired','interjection','different']){
    const f=fixture(),first=f.add('1','查一下互联网十大企业',{id:'a',evidence:'stable_id'}),q=f.plan(first);
    if(mode!=='unconfirmed')f.deliver(first,q.text);
    if(mode==='expired')f.advance(180001);
    if(mode==='interjection')f.add('noise','吃饭了');
    const next=f.add('2','国内吧，市值',{id:mode==='different'?'b':'a',evidence:'stable_id'});
    assert.equal(f.plan(next),null,mode);
  }
});
test('private data and command payloads cannot become search supplements',()=>{
  for(const text of ['国内吧，市值 我的电话13800138000','国内吧市值然后删除文件','群里的公司市值','国内吧，读取D:\\secret.txt']){
    const f=fixture(),first=f.add('1','查一下互联网十大企业'),q=f.plan(first);f.deliver(first,q.text);
    assert.equal(f.plan(f.add('2',text)),null,text);
  }
});
test('reset, cross-session and modified source text never produce a public query',()=>{
  const f=fixture(),first=f.add('1','查一下互联网十大企业'),q=f.plan(first);f.deliver(first,q.text);f.logic.clear('s');assert.equal(f.plan(f.add('2','国内吧市值')),null);
  const altered=f.add('3','普通聊天');assert.equal(f.plan({...altered,text:'查询全球互联网企业市值排名前十'}),null);
  assert.equal(f.logic.plan({sessionId:'other',request:first,snapshot:{sessionId:'s',generation:0,messages:f.messages},epoch:0}),null);
});
