import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import diagnostics from '../src/runtime_status.cjs';

function files(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoxi-status-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return {dir,load:name=>JSON.parse(fs.readFileSync(path.join(dir,name+'.json'),'utf8'))};
}
const snapshot=(pid,stage='listening')=>({at:new Date().toISOString(),pid,connection:{stage:'connected'},targets:{team:{stage}}});

test('failed snapshot serialization preserves its previous contents',t=>{
  const {dir,load}=files(t),file=path.join(dir,'runtime_status.json');
  diagnostics.writeJsonAtomic(file,{pid:8});
  assert.throws(()=>diagnostics.writeJsonAtomic(file,{pid:1n}));
  assert.deepEqual(load('runtime_status'),{pid:8});
});
test('a stale partial write is replaced and a missing history initializes',t=>{
  const {dir,load}=files(t);fs.writeFileSync(path.join(dir,'runtime_status.json.new'),'partial');
  const state=snapshot(1);diagnostics.createRuntimeWriter(dir)(state);
  assert.deepEqual(load('runtime_status'),state);assert.equal(load('connection_history').length,1);
});
test('unchanged polls do not append history; a window error adds only its category',t=>{
  const {dir,load}=files(t),record=diagnostics.createRuntimeWriter(dir);
  record(snapshot(1));record(snapshot(1));const failed=snapshot(1,'error');
  failed.targets.team.message='缺少独立窗口 secret conversation';record(failed);
  const history=load('connection_history');assert.equal(history.length,2);
  assert.deepEqual(history[1].rooms.team,['error','room_window']);assert.ok(!JSON.stringify(history).includes('secret'));
});
test('a new process keeps the last connection transition across restart',t=>{
  const {dir,load}=files(t);diagnostics.createRuntimeWriter(dir)(snapshot(9));diagnostics.createRuntimeWriter(dir)(snapshot(11));
  assert.deepEqual(load('connection_history').map(row=>row.pid),[9,11]);
});
test('the history is bounded and old invalid diagnostic JSON is recoverable',t=>{
  const {dir,load}=files(t);fs.writeFileSync(path.join(dir,'connection_history.json'),Buffer.alloc(32));
  diagnostics.createRuntimeWriter(dir)(snapshot(1));
  fs.writeFileSync(path.join(dir,'connection_history.json'),JSON.stringify(Array.from({length:200},(_,pid)=>({pid}))));
  diagnostics.createRuntimeWriter(dir)(snapshot(240));const entries=load('connection_history');
  assert.equal(entries.length,200);assert.equal(entries[0].pid,1);assert.equal(entries.at(-1).pid,240);
});
