import test from 'node:test';
import assert from 'node:assert/strict';
import {compactModelReferences} from '../src/model_reference_view.mjs';
const message=value=>({role:'user',content:JSON.stringify(value)});
test('long native references shrink losslessly without changing text or speaker evidence',()=>{
 const text='原句：预算50元，不吃辣。\nconst x = 1.25; '.repeat(10),key='1792840504/1836520/group_abao/100/mmui::ChatTextItemView/'+text;
 const sender={evidence:'stable_id',id:key,label:'同名成员'};
 const rows=[message({type:'observed_conversation',observations:[{sourceKey:'ref_1',text:'短编号'},
  {sourceKey:key,text,sender,receivedAt:100,quote:{sourceKey:key,text:'引用原句',sender}}]}),
  message({type:'current_request',sourceKey:key,text,sender,sourceKeys:[key],engagement:{anchorSourceKey:key,replyToSourceKey:key,requestBeforeReplySourceKey:key}})];
 const before=structuredClone(rows),view=compactModelReferences(rows),observed=JSON.parse(view.messages[0].content),current=JSON.parse(view.messages[1].content);
 const row=observed.observations[1];assert.equal(row.sourceKey,'ref_2');assert.equal(row.text,text);assert.deepEqual(row.sender,sender);assert.equal(row.receivedAt,100);
 assert.equal(row.quote.text,'引用原句');assert.deepEqual(row.quote.sender,sender);assert.equal(row.quote.sourceKey,row.sourceKey);
 assert.equal(current.sourceKey,row.sourceKey);assert.deepEqual(current.sourceKeys,[row.sourceKey]);
 assert.equal(current.engagement.replyToSourceKey,row.sourceKey);assert.equal(current.engagement.requestBeforeReplySourceKey,row.sourceKey);
 assert.equal(view.restore[row.sourceKey],key);assert.deepEqual(rows,before);
 assert.ok(JSON.stringify(view.messages).length<JSON.stringify(rows).length-1500);
});
test('literal JSON in ordinary chat and unrelated memory/profile fields stay byte-for-byte unchanged',()=>{
 const rows=[{role:'system',content:'sourceKey: do not touch'},
  message({type:'approved_memory_background',facts:[{sourceKey:'a'.repeat(200),text:'original'}]}),
  message({type:'owner_confirmed_group_profile',sourceKey:'b'.repeat(200)}),
  {role:'assistant',content:JSON.stringify({type:'current_request',sourceKey:'c'.repeat(200)})},
  message({type:'current_request',sourceKey:'short',text:'{"sourceKey":"'+'d'.repeat(200)+'"}'})];
 const view=compactModelReferences(rows);assert.deepEqual(view.messages,rows);assert.deepEqual(view.restore,{});
});
