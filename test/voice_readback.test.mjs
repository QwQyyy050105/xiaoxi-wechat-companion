import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Companion} from '../src/core.mjs';
import {MessageGate} from '../src/message_gate.mjs';
import {LiveVoiceReadback,wantsVoiceReadback} from '../src/voice_readback.mjs';
import {normalizeNativeMedia} from '../src/native_media.mjs';

const row=(id,text='未播放')=>({id,klass:'mmui::ChatVoiceItemView',text:'语音3"秒'+text});
const plain=(id,text)=>({id,klass:'mmui::ChatTextItemView',text});
const frame=(messages=[])=>({pid:1,created:2,hwnd:3,messages});
const norm=(id,text)=>normalizeNativeMedia(row(id,text));

test('live conversion/failure/retry produces status changes once without confusing failures with words',()=>{
  const gate=new MessageGate(),target={id:'team'},anchor=plain('a','anchor');
  gate.observe(target,frame([anchor]));
  for(const [label,stage] of [['未播放','waiting'],['正在转文字…','converting'],['转文字失败， 请重试。','failed']]){
    const input=frame([anchor,row('v',label)]),change=gate.observe(target,input);
    assert.equal(change.messages[0].inputModality.stage,stage);
    assert.deepEqual(gate.observe(target,input).messages,[]);
  }
  const done=frame([anchor,row('v','六点关窗')]);
  assert.equal(gate.observe(target,done).messages[0].text,'六点关窗');
  assert.deepEqual(gate.observe(target,done).messages,[]);
});
test('previously unread voice from launch baseline is never picked up by a status update',()=>{
  const gate=new MessageGate(),target={id:'team'};
  gate.observe(target,frame([row('v')]));
  for(const label of ['转文字中','转文字失败，请重试','旧话']){
    assert.deepEqual(gate.observe(target,frame([row('v',label)])).messages,[]);
  }
});
test('scope and actual bubble ID bind readback even when second voice arrives or another room reuses an ID',()=>{
  const track=new LiveVoiceReadback(()=>1000);
  track.observe('here',norm('a'));track.request('here').wait();
  track.observe('here',norm('b'));
  assert.equal(track.observe('other',norm('a','另一组的内容')),null);
  assert.equal(track.observe('here',norm('b','第二条')),null);
  assert.match(track.observe('here',norm('a','第一条')),/第一条/u);
  assert.equal(track.observe('here',norm('a','第一条')),null);
  assert.match(track.request('here').text,/第二条/u);
});
test('cancelling, stopping and expiring an ask suppresses the late follow-up',()=>{
  for(const operation of ['cancel','clear','expire']) {
    let t=1000;const track=new LiveVoiceReadback(()=>t);
    track.observe('team',norm('a'));track.request('team').wait();
    if(operation==='expire')t+=300001;else track[operation]('team');
    assert.equal(track.observe('team',norm('a','清晨')),null);
  }
});
test('readback vocabulary does not catch negation, outbound voice, analysis or a named third speaker',()=>{
  for(const text of ['小汐，刚才那条语音说了啥','@小汐 把刚发来的语音转成文字','听一下这段录音'])assert.ok(wantsVoiceReadback(text,['小汐']),text);
  for(const text of ['不用听语音','用语音回复我','比较两条语音','小明的语音说了啥','明天用语音回复我','语音里说的价格合理吗'])assert.equal(wantsVoiceReadback(text,['小汐']),false,text);
});

function fixture(t) {
  const temp=path.resolve('temp');fs.mkdirSync(temp,{recursive:true});
  const root=fs.mkdtempSync(path.join(temp,'voice_readback_'));
  fs.copyFileSync('character_card.json',path.join(root,'character_card.json'));
  const models=[],sent=[];
  const core=new Companion({root,codec:{encode:v=>Buffer.from(v),decode:v=>v.toString()},
    model:async args=>{models.push(args);return {text:'模型内容'};}});
  core.running=true;core.schedule=()=>{};
  core.bridge={async kill(){},async call(op,args){assert.equal(op,'send');sent.push(args);return {status:'local_echo',ids:['out'+sent.length]};}};
  t.after(async()=>{await core.stop();assert.equal(path.dirname(root),temp);fs.rmSync(root,{recursive:true,force:true});});
  return {core,target:core.store.value.targets[0],sent,models};
}
async function idle(core) {
  const cutoff=Date.now()+3000;
  while(core.processing.size || [...core.pending.values()].some(q=>q.length)){
    assert.ok(Date.now()<cutoff,'timeout waiting for reply');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}
test('group requests newest voice while a previous one has text; its later unattributed transcript sends exactly once via normal outbox',async t=>{
  const {core,target,sent,models}=fixture(t);
  const alias=core.policy.names[0];
  core.ingest(target,norm('first','旧内容'),frame());
  core.ingest(target,row('newer'),frame());
  core.ingest(target,plain('ask',alias+'，刚才那条语音说了什么'),frame());
  await idle(core);
  assert.equal(sent.length,1);assert.match(sent[0].text,/还没出文字/u);assert.doesNotMatch(sent[0].text,/旧内容/u);
  core.ingest(target,row('newer','带上钥匙'),frame());
  await idle(core);
  assert.equal(sent.length,2);assert.match(sent[1].text,/带上钥匙/u);
  core.ingest(target,row('newer','带上钥匙'),frame());
  await idle(core);assert.equal(sent.length,2);assert.equal(models.length,0);
});
test('an explicit transcript request with an existing live voice returns without a model call',async t=>{
  const {core,target,sent,models}=fixture(t);
  core.ingest(target,row('v','六点出门'),frame());
  core.ingest(target,plain('ask',core.policy.names[0]+'，刚才的语音说了什么'),frame());
  await idle(core);assert.equal(sent.length,1);assert.match(sent[0].text,/六点出门/u);assert.equal(models.length,0);
});
