import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Companion} from '../src/core.mjs';
import {MessageGate} from '../src/message_gate.mjs';
import {standaloneVoiceRequest,summarizeVoiceDelivery} from '../src/voice_reply_receipt.mjs';
import {LiveVoiceReadback,wantsVoiceReadback} from '../src/voice_readback.mjs';
import {normalizeNativeMedia} from '../src/native_media.mjs';
import {loadVoiceTargets,VoiceIntakeScope} from '../src/voice_scope.mjs';

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
  const target=core.store.value.targets[0];
  const windows=new Map();
  core.bridge={child:{},async kill(){this.child=null;},async stop(){this.child=null;},async call(op,args){
    if(op==='health')return {healthy:true};
    if(op==='read')return frame(windows.get(args.group)??[plain('anchor','baseline')]);
    assert.equal(op,'send');sent.push(args);return {status:'local_echo',ids:['out'+sent.length]};
  }};
  async function pollRoom(room,...rows) {
    windows.set(room.name,[plain('anchor','baseline'),...rows]);
    await core.tick();
    await idle(core);
  }
  t.after(async()=>{await core.stop();assert.equal(path.dirname(root),temp);fs.rmSync(root,{recursive:true,force:true});});
  return {core,target,sent,models,poll:(...rows)=>pollRoom(target,...rows),pollRoom};
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

test('a directly addressed voice already transcribed on first live observation replies once',async t=>{
  const {core,target,poll,sent,models}=fixture(t);
  const voice=row('first',core.policy.names[0]+'，周末想聊哪本书');
  await poll();
  await poll(voice);
  await poll(voice);
  assert.equal(models.length,1);
  assert.equal(models[0].session.request.inputModality.kind,'platform_transcript');
  assert.deepEqual(sent.map(x=>x.group),[target.name]);
});

test('a live voice receives a single direct reply after its in-place conversion',async t=>{
  const {core,poll,sent,models}=fixture(t);
  await poll();
  await poll(row('one'));
  await poll(row('one','正在转文字'));
  assert.deepEqual(sent,[]);
  const spoken=row('one',core.policy.names[0]+'，你会看小说吗');
  await poll(spoken);
  await poll(spoken);
  assert.equal(sent.length,1);assert.equal(models.length,1);
});

test('two incoming voices can start and continue a conversation without a second name',async t=>{
  const {core,poll,sent,models}=fixture(t);
  const first=row('v1',core.policy.names[0]);
  await poll();
  await poll(first);
  await poll(first,row('v2','今晚看哪本书好？'));
  assert.equal(sent.length,2);assert.equal(models.length,1);
  assert.equal(models[0].session.request.text,'今晚看哪本书好？');
  assert.equal(models[0].session.request.engagement.relation,'current_group_topic');
});

test('older converted rows and unaddressed live group talk stay silent',async t=>{
  const {core,poll,sent,models}=fixture(t);
  const older=row('old',core.policy.names[0]+'，这是旧消息');
  await poll(older);
  await poll(older,row('side','我们已经到了'));
  assert.deepEqual(sent,[]);assert.deepEqual(models,[]);
});

test('a paused group does not answer an incoming addressed voice',async t=>{
  const {core,target,poll,sent,models}=fixture(t);
  core.store.change(state=>{state.targets.find(x=>x.id===target.id).paused=true;});
  await poll();
  await poll(row('v',core.policy.names[0]+'，你在忙什么'));
  assert.deepEqual(sent,[]);assert.deepEqual(models,[]);
});

test('confirmed bot echoes and owner-side voice bubbles do not trigger another turn',async t=>{
  const {core,poll,sent,models}=fixture(t);
  const first=row('v1',core.policy.names[0]+'，想推荐一本什么书');
  await poll();await poll(first);
  const returned=plain('out1',sent[0].text);
  const ownVoice={...row('vo',core.policy.names[0]+'，这是我自己发的语音'),own:true};
  await poll(first,returned,ownVoice);
  assert.equal(sent.length,1);assert.equal(models.length,1);
});

test('a voice repeating recent outgoing text is still an incoming group message',async t=>{
  const {core,poll,sent,models}=fixture(t);
  const first=row('v1',core.policy.names[0]+'，说说你在读的书');
  await poll();await poll(first);
  const echo=plain('out1',sent[0].text);
  await poll(first,echo,row('another',echo.text));
  assert.equal(models.length,2);
  assert.equal(models[1].session.request.inputModality.kind,'platform_transcript');
  assert.equal(sent.length,2);
});

test('spoken words resembling another WeChat label are normalized only once',async t=>{
  const {core,target,poll}=fixture(t);
  await poll();
  await poll(row('v','语音3秒这个格式怎么念'));
  const message=core.context.snapshot(core.sessionFor(target.id).id).messages.find(item=>item.id==='v');
  assert.equal(message.text,'语音3秒这个格式怎么念');
});

test('a reused outgoing text ID in another window does not silence a new voice',async t=>{
  const {core,target,poll,pollRoom,sent}=fixture(t);
  const other=core.store.value.targets.find(room=>room.id!==target.id);
  await poll();
  await poll(row('v',core.policy.names[0]+'，说说昨天的活动'));
  assert.equal(sent.length,1);
  await pollRoom(other,row('out1',core.policy.names[0]+'，今天有空吗'));
  assert.deepEqual(sent.map(x=>x.group),[target.name,other.name]);
});

test('a voice-disabled room retains text and images but never puts transcripts into the gate, baseline or live context',async t=>{
  const {core,target,poll,pollRoom,sent,models}=fixture(t);
  const other=core.store.value.targets.find(room=>room.id!==target.id);
  core.voiceScope=new VoiceIntakeScope(()=>[target.id]);
  const session=core.sessionFor(other.id);
  const forbidden=row('outside',core.policy.names[0]+'，这段声音只属于另一个群');
  const typed=plain('typed','群里的普通文字');
  const audio={kind:'audio',resourceId:'voice-handle',available:true};
  const image={kind:'image',resourceId:'picture-handle',available:true};
  const mixed={...typed,attachments:[image,audio],quote:{kind:'audio',status:'resolved',verified:true,text:'非授权引用'}};
  await pollRoom(other,forbidden,mixed);
  await pollRoom(other,forbidden,mixed,{...forbidden,id:'later',inputModality:{kind:'asr_transcript'}});
  core.ingest(other,{...mixed,id:'live-photo'},frame());
  core.ingest(other,{...forbidden,id:'direct',klass:typed.klass,inputModality:{kind:'platform_transcript'}},frame());
  const context=core.context.snapshot(session.id);
  assert.deepEqual(context.messages.filter(x=>x.id==='typed').map(x=>x.attachments.map(a=>a.kind)),[['image']]);
  assert.equal(context.messages.find(x=>x.id==='typed').text,typed.text);
  assert.deepEqual(context.messages.find(x=>x.id==='live-photo').attachments.map(a=>a.kind),['image']);
  assert.equal(context.messages.find(x=>x.id==='live-photo').quote,null);
  assert.doesNotMatch(JSON.stringify([core.gate.rooms.get(other.id),context]),/另一个群|非授权引用|voice-handle/u);
  assert.equal(core.voiceReadbacks.latest(session.id),undefined);
  assert.deepEqual(sent,[]);assert.deepEqual(models,[]);
  await poll();
  await poll(row('allowed',core.policy.names[0]+'，说一句话'));
  assert.deepEqual(sent.map(x=>x.group),[target.name]);
});

test('voice labels on image rows stay out of a disabled room at baseline and during live ingestion',async t=>{
  const {core,target,pollRoom,sent,models}=fixture(t);
  core.voiceScope=new VoiceIntakeScope(()=>[]);
  const session=core.sessionFor(target.id);
  const image={kind:'image',resourceId:'allowed-photo',available:true};
  const picture={...row('picture','private synthetic words'),klass:'mmui::ChatImageItemView',attachments:[image]};
  const album={...picture,id:'album',klass:'mmui::ChatImageGroupItemView'};
  await pollRoom(target,picture);
  await pollRoom(target,picture,album);
  core.ingest(target,{...picture,id:'direct'},frame());
  core.ingest(target,{...plain('comment','普通文字'),quote:{...album,verified:true,status:'resolved'}},frame());
  const context=core.context.snapshot(session.id);
  assert.doesNotMatch(JSON.stringify([core.gate.rooms.get(target.id),context]),/private synthetic words/);
  assert.equal(context.messages.find(message=>message.id==='comment').quote,null);
  assert.equal(core.voiceReadbacks.latest(session.id),undefined);
  assert.deepEqual(core.voiceScope.row(target.id,picture).attachments,[image]);
  assert.deepEqual(sent,[]);assert.deepEqual(models,[]);
});

test('manual audio requests in a disabled group do not open handles retained by an older configuration',async t=>{
  const {core,target,models}=fixture(t);
  const session=core.sessionFor(target.id);
  core.context.observe(session.id,{id:'before',sourceKey:'before',text:'[语音]',attachments:[{kind:'audio',resourceId:'old',available:true}]});
  core.voiceScope=new VoiceIntakeScope(()=>[]);
  core.media={...core.media,analyze:()=>assert.fail('disabled group resolved audio')};
  const answer=await core.serviceReply(session.id,{text:core.policy.names[0]+'，听一下这段语音'},{target});
  assert.match(answer,/没有开启语音/u);
  assert.equal(models.length,0);
});

test('template voice settings preserve the legacy group set and honor an explicit empty or selected set',t=>{
  const {core}=fixture(t);
  const file=path.join(core.root,'deployment.local.json');
  const targets=core.store.value.targets.map(({id,name,kind})=>({id,name,kind}));
  const ids=targets.map(target=>target.id);
  for (const [native,expected] of [[{},ids],[{voiceTargetIds:[]},[]],[{voiceTargetIds:[ids[0]]},[ids[0]]]]) {
    fs.writeFileSync(file,JSON.stringify({schemaVersion:1,targets,native}));
    assert.deepEqual(loadVoiceTargets(file),expected);
  }
});
test('only an unambiguous single voice request can claim its reply',()=>{
  const voice={inputModality:{kind:'platform_transcript'}};
  const text={inputModality:{kind:'text'}};
  assert.equal(standaloneVoiceRequest([voice]),voice);
  for(const batch of [[voice,text],[text,voice],[voice,voice],[text],[]])assert.equal(standaloneVoiceRequest(batch),null);
});
test('a native voice receipt reports all local echoes without claiming recipient delivery',()=>{
  const observed=[{status:'local_echo',wechatForegroundObserved:false,ids:['opaque-id'],note:'private text'}];
  const receipt=summarizeVoiceDelivery(100,1,observed,150);
  assert.deepEqual(receipt,{observedAt:new Date(100).toISOString(),finishedAt:new Date(150).toISOString(),
    status:'local_echo',expectedParts:1,confirmedParts:1,wechatForegroundObserved:false,recipientReceipt:'unavailable'});
});
test('split voice reply with a missing echo retains partial outcome and foreground evidence',()=>{
  const parts=[{status:'local_echo',wechatForegroundObserved:true},{status:'unknown',wechatForegroundObserved:false}];
  const rec=summarizeVoiceDelivery(100,2,parts,200);
  assert.equal(rec.status,'partial');assert.equal(rec.confirmedParts,1);assert.equal(rec.wechatForegroundObserved,true);
  const missing=summarizeVoiceDelivery(100,2,[parts[1]],200);
  assert.equal(missing.status,'unknown');assert.equal(missing.wechatForegroundObserved,null);
});
test('no native response is not a receipt and unmeasured focus stays unknown',()=>{
  assert.equal(summarizeVoiceDelivery(100,1,[],150),null);
  const rec=summarizeVoiceDelivery(100,1,[{status:'not_sent',wechatForegroundObserved:null}],150);
  assert.equal(rec.status,'not_sent');assert.equal(rec.wechatForegroundObserved,null);
});
test('a simulated or plugin send cannot create a real voice receipt even when it supplies focus fields',async t=>{
  const {core,target,poll,sent}=fixture(t);
  const call=core.bridge.call.bind(core.bridge);
  core.bridge.call=async (...args)=>{const result=await call(...args);return args[0]==='send'?{...result,wechatForegroundObserved:false}:result;};
  await poll();await poll(row('voice',core.policy.names[0]+'，这周末看什么书？'));
  assert.equal(sent.length,1);
  assert.equal(core.store.value.targets.find(room=>room.id===target.id).lastNativeVoiceReply,undefined);
});
test('a later text, reminder and owner recovery preserve the existing voice receipt across target snapshots',async t=>{
  const {core,target,poll}=fixture(t);
  const saved=summarizeVoiceDelivery(100,1,[{status:'unknown',wechatForegroundObserved:false}],150);
  core.store.change(state=>{state.targets.find(r=>r.id===target.id).lastNativeVoiceReply=saved;});
  await poll();await poll(plain('text',core.policy.names[0]+'，几点见面？'));
  const session=core.sessionFor(target.id);
  for (const kind of ['owner_recovery','reminder']) {
    const out={id:'example_'+kind,kind,sessionId:session.id,text:'回复',requestIds:[]};
    core.store.change(state=>state.outbox.push(out));
    core.recordDelivery(target,session.id,out,{status:'local_echo',ids:[],note:'local echo'},{inputModality:{kind:'platform_transcript'}});
  }
  assert.deepEqual(core.snapshot().targets.find(room=>room.id===target.id).lastNativeVoiceReply,saved);
});
