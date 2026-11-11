import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {startPanel} from '../src/panel_server.mjs';
import {validateWave, MAX_WAVE_BYTES} from '../src/local_asr.mjs';
import {createMediaService} from '../src/media_service.mjs';
import {Companion} from '../src/core.mjs';
import {MessageGate} from '../src/message_gate.mjs';

function wave(samples = 800) {
  const b=Buffer.alloc(44+samples*2);
  b.write('RIFF'); b.writeUInt32LE(b.length-8,4); b.write('WAVEfmt ',8);
  b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22);
  b.writeUInt32LE(8000,24); b.writeUInt32LE(16000,28); b.writeUInt16LE(2,32);
  b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(samples*2,40);
  return b;
}

test('voice file accepts PCM16 and rejects spoofed chunks, format, size and duration',()=>{
  assert.equal(validateWave(wave()).length,1644);
  for(const edit of [b=>b.write('NOPE'),b=>b.writeUInt32LE(9999999,40),b=>b.writeUInt16LE(3,20),b=>b.writeUInt16LE(1,32)]){
    const b=wave();edit(b);assert.throws(()=>validateWave(b),/wave_/);
  }
  assert.throws(()=>validateWave(wave(8000*121)),/wave_duration_invalid/);
  assert.throws(()=>validateWave(Buffer.alloc(MAX_WAVE_BYTES+1)),/wave_size_invalid/);
});

test('owner panel accepts only authenticated WAV uploads and returns editable text without sending a chat',async t=>{
  let calls=0;
  const wav=wave(),root=path.resolve('.');
  const panel=await startPanel({root,port:0,core:{dispatch(){assert.fail('upload dispatched chat');}},
    transcribeWave:async(bytes,{language})=>{calls++;assert.deepEqual(bytes,wav);assert.equal(language,'en-US');return {text:'one two three',confidence:.72};}});
  t.after(()=>panel.close());
  const {token}=await fetch(panel.url+'/api/bootstrap').then(r=>r.json());
  const post=(headers,body=wav)=>fetch(panel.url+'/api/voice-file?language=en-US',{method:'POST',headers,body});
  const headers={Origin:panel.url,'Content-Type':'audio/wav','X-Xiaoxi-Token':token};
  assert.equal((await post({...headers,'X-Xiaoxi-Token':'invalid'})).status,403);
  assert.equal((await post({...headers,Origin:'https://external.invalid'})).status,403);
  assert.equal((await post({...headers,'Content-Type':'application/json'})).status,415);
  assert.equal((await post(headers,Buffer.alloc(MAX_WAVE_BYTES+1))).status,413);
  assert.equal((await (await post(headers)).json()).result.text,'one two three');
  assert.equal(calls,1);
});

const voice=text=>({id:'voice-1',klass:'mmui::ChatVoiceItemView',text:'语音3"秒'+text});
const frame=messages=>({pid:1,created:2,hwnd:3,messages});
const anchor={id:'anchor',text:'old',klass:'mmui::ChatTextItemView'};

test('WeChat conversion failure is a pending state; a later genuine retry gets through once',()=>{
  const gate=new MessageGate(), target={id:'team'};
  gate.observe(target,frame([anchor]));
  gate.observe(target,frame([anchor,voice('未播放')]));
  let result=gate.observe(target,frame([anchor,voice('转文字失败，请重试')]));
  assert.equal(result.messages.some(x=>x.inputModality?.kind==='platform_transcript'),false);
  result=gate.observe(target,frame([anchor,voice('小汐，明天聊什么')]));
  assert.deepEqual(result.messages.map(x=>x.text),['小汐，明天聊什么']);
  assert.deepEqual(gate.observe(target,frame([anchor,voice('小汐，明天聊什么')])).messages,[]);
});

function fixture(t,overrides={}) {
  const parent=path.resolve('temp');
  const root=fs.mkdtempSync(path.join(parent,'live_voice_'));
  fs.copyFileSync('character_card.json',path.join(root,'character_card.json'));
  const calls=[],sent=[],resolved=[];
  const media=createMediaService({
    resolveAttachment:async args=>{
      resolved.push(args);
      return {sessionId:args.sessionId,messageId:args.messageId,handle:args.handle,source:'wechat_attachment',mime:'audio/wav',bytes:wave(),...overrides.asset};
    },
    asr:overrides.asr??(async()=>({text:'小汐，明天聊什么书',confidence:.95}))
  });
  const core=new Companion({root,codec:{encode:v=>Buffer.from(v),decode:v=>v.toString()},media,
    extensions:{handlers:new Map(),has:cap=>cap==='transport',snapshot:()=>({})},
    model:async args=>{calls.push(args);return {text:'聊一本短篇集'};}});
  core.running=true;core.schedule=()=>{};core.bridge={async kill(){},async call(op,fields){assert.equal(op,'send');sent.push(fields);return {status:'local_echo',ids:['sent']};}};
  t.after(async()=>{await core.stop();assert.equal(path.dirname(root),parent);fs.rmSync(root,{force:true,recursive:true});});
  const target=core.store.value.targets[0];
  const row={...voice('未播放'),attachments:[{kind:'audio',available:true,resourceId:'sample'}]};
  return {core,calls,sent,resolved,target,row};
}
async function idle(core) {
  const deadline=Date.now()+2500;
  while(core.processing.size||core.audioJobs.size) {
    assert.ok(Date.now()<deadline,'voice work did not finish');
    await new Promise(resolve=>setTimeout(resolve,5));
  }
}
test('a scoped live audio handle transcribes into a real group turn; late platform text stays single',async t=>{
  const {core,calls,sent,resolved,target,row}=fixture(t);
  core.ingest(target,row,frame([]));await idle(core);
  assert.equal(calls.length,1);assert.equal(calls[0].session.request.inputModality.kind,'asr_transcript');
  assert.equal(resolved[0].sessionId,core.sessionFor(target.id).id);
  assert.equal(sent.length,1);assert.equal(sent[0].group,target.name);
  core.ingest(target,voice('小汐，明天聊什么书'),frame([]));await idle(core);
  assert.equal(calls.length,1);assert.equal(sent.length,1);
});
test('native placeholder and unauthorized group never open any attachment',async t=>{
  const {core,calls,resolved,target,row}=fixture(t);
  core.ingest(target,voice('未播放'),frame([]));
  core.ingest({...target,id:'unknown',name:'unknown'},row,frame([]));await idle(core);
  assert.deepEqual(resolved,[]);assert.deepEqual(calls,[]);
});
test('mismatched message, or an owner-uploaded file, cannot transcribe into a group',async t=>{
  for(const asset of [{messageId:'other'}, {source:'owner_upload'}]){
    const {core,sent,calls,target,row}=fixture(t,{asset,asr:()=>assert.fail('unscoped audio passed to ASR')});
    core.ingest(target,row,frame([]));await idle(core);
    assert.deepEqual(sent,[]);assert.deepEqual(calls,[]);
  }
});
test('stopping while recognition is pending cancels the result before any group reply',async t=>{
  let finish;
  const {core,target,row,sent,calls}=fixture(t,{asr:()=>new Promise(resolve=>{finish=resolve;})});
  core.ingest(target,row,frame([]));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof finish,'function');
  await core.stop();finish({text:'小汐，请回答',confidence:.99});await idle(core);
  assert.deepEqual(sent,[]);assert.deepEqual(calls,[]);
});
