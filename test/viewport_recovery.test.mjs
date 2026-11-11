import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Companion} from '../src/core.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.resolve('temp/viewport_'));
  fs.copyFileSync('character_card.json', path.join(root,'character_card.json'));
  let time = 10_000;
  const core = new Companion({root, nowMs:() => time, codec:{encode:s => Buffer.from(s), decode:b => b.toString()}});
  const target = core.store.value.targets.find(item => item.id === 'group_abao');
  core.store.change(state => { for (const item of state.targets) item.enabled = item.id === target.id; });
  const received = [];
  core.ingest = (_,row) => received.push(row.id);
  core.running = true;
  core.schedule = () => {};
  core.runTasks = async () => {};
  function rows(ids, hwnd = 1) {
    return {pid:20, created:100, hwnd, messages:ids.map(id => ({id,text:id,klass:'mmui::ChatTextItemView'}))};
  }
  let result = rows(['one','two']);
  core.bridge = {child:{}, async call(command) {
    if (command === 'health') return {};
    assert.equal(command,'read');
    if (result instanceof Error) throw result;
    return result;
  }};
  t.after(() => { core.running=false; core.bridge=null; fs.rmSync(root,{recursive:true,force:true}); });
  return {core,target,received, advance:ms => {time += ms;},
    async read(ids,hwnd) { result=rows(ids,hwnd); await core.tick(); },
    async fail(code='viewport_pending') { result=Object.assign(Error('reader unavailable'),{code}); await core.tick(); }};
}

test('short unread interruption preserves the first new message and emits it only once', async t => {
  const f=fixture(t); await f.read(['one','two']); await f.fail(); await f.fail();
  assert.equal(f.core.targetStates[f.target.id].stage,'waiting_viewport');
  await f.read(['two','three']); await f.read(['two','three']);
  assert.deepEqual(f.received,['three']);
});

test('unread at startup establishes a baseline on first readable snapshot', async t => {
  const f=fixture(t); await f.fail(); await f.read(['history']); await f.read(['history','live']);
  assert.deepEqual(f.received,['live']);
});

test('a different window after an unread hold never replays its history', async t => {
  const f=fixture(t); await f.read(['one','two']); await f.fail(); await f.read(['two','other'],2);
  assert.deepEqual(f.received,[]);
});

test('a gap in the visible rows establishes a new baseline', async t => {
  const f=fixture(t); await f.read(['one','two']); await f.fail(); await f.read(['three','four']);
  assert.equal(f.core.targetStates[f.target.id].stage,'gap'); assert.deepEqual(f.received,[]);
});

test('an expired hold cannot release delayed replies even if no poll ran during the gap', async t => {
  const f=fixture(t); await f.read(['one','two']); await f.fail(); f.advance(60_001);
  await f.read(['two','stale']); await f.read(['stale','live']); assert.deepEqual(f.received,['live']);
});

test('a real reader failure drops the cursor immediately and invalidates only once', async t => {
  const f=fixture(t); await f.read(['one','two']); let resets=0;
  const invalidate=f.core.invalidateSession.bind(f.core);
  f.core.invalidateSession=(...args)=>{resets++;return invalidate(...args);};
  await f.fail(); await f.fail('binding_changed'); await f.fail('binding_changed');
  assert.equal(resets,1); await f.read(['two','uncertain']); assert.deepEqual(f.received,[]);
});
