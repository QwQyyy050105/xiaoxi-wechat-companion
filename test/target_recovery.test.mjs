import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Companion} from '../src/core.mjs';

const targetId='group_abao';
const row=id=>({id,text:`小汐 ${id}`,klass:'mmui::ChatTextItemView'});
const snapshot=ids=>({pid:20,created:100,hwnd:1,windowBinding:'test:abao',messages:ids.map(row),draft:false});
function fixture(t,read){
  const root=fs.mkdtempSync(path.resolve('temp/target_recovery_'));
  fs.copyFileSync('character_card.json',path.join(root,'character_card.json'));
  const core=new Companion({root,codec:{encode:s=>Buffer.from(s),decode:b=>b.toString()},model:async()=>{throw Error('No model call permitted');}});
  core.running=true;core.connection={stage:'connected'};core.schedule=()=>{};
  core.store.change(s=>{const target=s.targets.find(x=>x.id===targetId);target.quarantined=true;target.windowBinding='test:abao';});
  core.suspended.add(targetId);
  core.bridge={child:{},call:async(command,fields)=>{assert.equal(command,'read');assert.equal(fields.group,'Example Group A');return read();}};
  const target=core.store.value.targets.find(x=>x.id===targetId);
  core.gate.observe(target,snapshot(['old']));
  t.after(()=>{core.running=false;core.bridge=null;fs.rmSync(root,{recursive:true,force:true});});
  return {core,target};
}

test('recovery establishes its baseline before returning so the very next new message is delivered once',async t=>{
  let reads=0;const {core,target}=fixture(t,()=>{reads++;return snapshot(['old','during_pause']);});
  await core.dispatch('target.acknowledge',{id:targetId});
  assert.equal(reads,1);
  const received=core.gate.observe(target,snapshot(['old','during_pause','after_recovery']));
  assert.deepEqual(received.messages.map(x=>x.id),['after_recovery']);
  assert.deepEqual(core.gate.observe(target,snapshot(['old','during_pause','after_recovery'])).messages,[]);
  assert.equal(core.store.value.inbox.length,0,'paused messages are background, never queued');
  assert.equal(core.store.value.outbox.length,0,'recovery itself never sends');
});

test('failed recovery read leaves quarantine enabled',async t=>{
  const {core}=fixture(t,()=>{throw Error('read failed');});
  await assert.rejects(core.dispatch('target.acknowledge',{id:targetId}),/read failed/);
  assert.equal(core.suspended.has(targetId),true);
  assert.equal(core.store.value.targets.find(x=>x.id===targetId).quarantined,true);
});

test('a connection change during recovery cannot clear quarantine or replace its new baseline',async t=>{
  let release;const {core,target}=fixture(t,()=>new Promise(resolve=>{release=resolve;}));
  const recovery=core.dispatch('target.acknowledge',{id:targetId});
  assert.equal(typeof release,'function');
  core.generation++;core.gate.observe(target,{...snapshot(['new_connection']),hwnd:2});
  release(snapshot(['old','during_pause']));
  await assert.rejects(recovery,/连接.*变化/);
  assert.equal(core.suspended.has(targetId),true);
  assert.equal(core.gate.rooms.get(targetId).generation,'20/100/2');
});
