import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DesktopTransport} from '../src/desktop_transport.mjs';
import {Companion} from '../src/core.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));

function transportFixture(t) {
  const transport = new DesktopTransport(path.resolve('.'));
  const written = [];
  transport.child = {stdin: {write: text => written.push(JSON.parse(text))}};
  // No native process is started. Each request is released as a stub worker receipt.
  const release = (id, result = {ok: true}) => {
    const waiting = transport.requests.get(id);
    assert.ok(waiting, `stub request ${id} should exist`);
    clearTimeout(waiting.timer); transport.requests.delete(id); waiting.resolve(result);
  };
  t.after(() => {for (const task of transport.requests.values()) clearTimeout(task.timer); transport.requests.clear(); transport.child = null;});
  return {transport, written, release};
}

test('beforeSubmit is checked at actual serialized execution and false means no stdin write', async t => {
  const {transport, written, release} = transportFixture(t);
  const blocker = transport.call('health'); await turn();
  let allowed = true, checks = 0;
  const pending = transport.call('send', {group: 'Example Group A', text: '已失效'}, 1000, {beforeSubmit: () => {checks++; return allowed;}});
  const rejected = assert.rejects(pending, error => error.sendNotSubmitted === true);
  assert.equal(checks, 0);
  allowed = false; release(written[0].id); await blocker; await rejected;
  assert.equal(checks, 1); assert.deepEqual(written.map(item => item.command), ['health']);
});

test('aborting a send while it waits behind another command never writes that send', async t => {
  const {transport, written, release} = transportFixture(t), controller = new AbortController();
  const blocker = transport.call('read', {group: 'Example Group B'}); await turn();
  const pending = transport.call('send', {group: 'Example Group A', text: '取消这条'}, 1000, {signal: controller.signal, beforeSubmit: () => true});
  const rejected = assert.rejects(pending, error => error.sendNotSubmitted === true);
  controller.abort(); release(written[0].id); await blocker; await rejected;
  assert.equal(written.length, 1);
});

test('an expired queued send is rejected by the current deadline, not the value when enqueued', async t => {
  const {transport, written, release} = transportFixture(t);
  let time = 100;
  const blocker = transport.call('read', {group: 'Example Group B'}); await turn();
  const pending = transport.call('send', {group: 'Example Group A', text: '过期提醒'}, 1000, {beforeSubmit: () => time < 200});
  const rejected = assert.rejects(pending, error => error.sendNotSubmitted === true);
  time = 201; release(written[0].id); await blocker; await rejected;
  assert.equal(written.length, 1);
});

test('a true submission guard permits exactly one command and preserves the worker receipt', async t => {
  const {transport, written, release} = transportFixture(t);
  const pending = transport.call('send', {group: 'Example Group A', text: '有效'}, 1000, {beforeSubmit: () => true});
  await turn(); assert.equal(written.length, 1);
  release(written[0].id, {status: 'local_echo', ids: ['bubble']});
  assert.deepEqual(await pending, {status: 'local_echo', ids: ['bubble']});
});

function fakeTransport(sent) {
  return {child: {}, start() {}, async kill() {this.child = null;}, async stop() {this.child = null;}, async call(command, fields = {}) {
    if (command === 'connect') return {account: 'Example Account', pid: 20, created: 100};
    if (command === 'health') return {healthy: true};
    if (command === 'open' || command === 'read') return {pid: 20, created: 100, hwnd: fields.group === 'Example Group B' ? 2 : 1, windowBinding: `fake:${fields.group}`, messages: [], draft: false};
    if (command === 'send') {sent.push(fields); return {status: 'local_echo', ids: []};}
    throw Error(`Unexpected fake command ${command}`);
  }};
}

function coreFixture(t) {
  const root = fs.mkdtempSync(path.resolve('temp/submission_guard_test_'));
  fs.mkdirSync(path.join(root, 'temp')); fs.copyFileSync('character_card.json', path.join(root, 'character_card.json'));
  const codec = {encode: value => Buffer.from(value), decode: value => value.toString()};
  const instances = [], sent = [];
  const make = () => {
    const core = new Companion({root, codec, model: async () => ({text: '离线桩回答'}),
      voice: {async status() {return {ready: false, available: false};}},
      media: {capabilities() {return {image: false, audio: false};}},
      transportFactory: () => fakeTransport(sent)});
    core.schedule = () => {}; core.modelState = {stage: 'ready'}; instances.push(core); return core;
  };
  t.after(async () => {
    for (const core of instances) await core.stop();
    assert.equal(path.dirname(path.resolve(root)), path.resolve('temp'));
    assert.ok(path.basename(root).startsWith('submission_guard_test_'));
    fs.rmSync(root, {recursive: true, force: true});
  });
  return {core: make(), make, sent};
}

function prepared(core, text = '原话题的回答') {
  const target = core.store.value.targets[0], session = core.sessionFor(target.id);
  const out = {id: `out-${Math.random()}`, sessionId: session.id, epoch: session.epoch, contextGeneration: core.context.generation(session.id), text, createdAt: new Date().toISOString(), status: 'sending', kind: 'reply'};
  core.store.change(state => state.outbox.push(out));
  return {target, session, out};
}

for (const invalidation of ['context_generation', 'session_epoch']) {
  test(`a late confirmed receipt after ${invalidation} change is durable but cannot seed new context or followups`, t => {
    const {core} = coreFixture(t), {target, session, out} = prepared(core);
    if (invalidation === 'context_generation') core.context.clear(session.id, '换话题');
    else core.store.change(state => {state.sessions.find(item => item.id === session.id).epoch++;});
    let observations = 0, followups = 0;
    const observe = core.context.observe.bind(core.context), noteReply = core.policy.noteReply.bind(core.policy);
    core.context.observe = (...args) => {observations++; return observe(...args);};
    core.policy.noteReply = (...args) => {followups++; return noteReply(...args);};
    core.recordDelivery(target, session.id, out, {status: 'local_echo', ids: ['bubble']}, {sourceKey: 'old-request', sender: {id: 'member-a', evidence: 'stable_id'}});
    assert.equal(core.store.value.outbox.find(item => item.id === out.id).status, 'local_echo');
    assert.ok(core.store.session(session.id).messages.some(item => item.id === out.id && item.text === out.text));
    assert.equal(observations, 0); assert.equal(followups, 0);
    assert.equal(core.context.snapshot(session.id).messages.length, 0); assert.equal(core.policy.state(session.id).followup, null);
  });
}

test('session reset cancels queued work and clears ephemeral context plus followup state', async t => {
  const {core} = coreFixture(t), session = core.sessionFor(core.store.value.targets[0].id);
  const event = {id: 'question', sourceKey: 'question', text: '旧的事实', receivedAt: Date.now(), sender: {id: 'member-a', evidence: 'stable_id'}};
  core.context.observe(session.id, event); core.policy.noteReply(session.id, event, {confirmed: true});
  core.store.change(state => state.inbox.push({id: 'queued', sessionId: session.id, status: 'queued'}));
  core.pending.set(session.id, ['queued']);
  const controller = new AbortController(); core.controllers.set(session.id, controller);
  const generation = core.context.generation(session.id);
  await core.dispatch('session.reset', {sessionId: session.id});
  assert.equal(controller.signal.aborted, true);
  assert.equal(core.pending.get(session.id)?.length ?? 0, 0);
  assert.equal(core.store.value.inbox.find(item => item.id === 'queued').status, 'skipped');
  assert.equal(core.context.snapshot(session.id).messages.length, 0);
  assert.equal(core.context.generation(session.id), generation + 1);
  assert.equal(core.policy.state(session.id).followup, null);
});

test('unknown quarantine survives a fresh core and default auto-start until explicit target acknowledgement', async t => {
  const {core, make, sent} = coreFixture(t), {target, session, out} = prepared(core);
  core.recordDelivery(target, session.id, out, {status: 'unknown', note: '实际发送未确认', ids: []});
  assert.equal(core.store.value.targets.find(item => item.id === target.id).quarantined, true);
  await core.stop();
  const restarted = make();
  assert.equal(restarted.suspended.has(target.id), true);
  await restarted.start();
  assert.equal(restarted.connection.stage, 'connected');
  assert.equal(restarted.suspended.has(target.id), true);
  assert.equal(restarted.store.value.targets.find(item => item.id === target.id).quarantined, true);
  await restarted.tick();
  assert.equal(restarted.targetStates[target.id].stage, 'error');
  assert.equal(sent.length, 0);
  await restarted.dispatch('target.acknowledge', {id: target.id});
  assert.equal(restarted.suspended.has(target.id), false);
  assert.equal(restarted.store.value.targets.find(item => item.id === target.id).quarantined, false);
  assert.equal(restarted.store.value.outbox.find(item => item.id === out.id).status, 'unknown');
  assert.equal(sent.length, 0, 'acknowledgement must not replay the old answer');
  await restarted.stop();
  const afterAcknowledgement = make();
  assert.equal(afterAcknowledgement.suspended.has(target.id), false, 'a later restart must preserve the explicit acknowledgement');
});

test('legacy persisted unknown receipts acquire quarantine during migration', async t => {
  const {core, make} = coreFixture(t), {target, out} = prepared(core);
  core.store.change(state => {
    delete state.targets.find(item => item.id === target.id).quarantined;
    state.outbox.find(item => item.id === out.id).status = 'unknown';
  });
  await core.stop();
  const restored = make();
  assert.equal(restored.suspended.has(target.id), true);
  assert.equal(restored.store.value.targets.find(item => item.id === target.id).quarantined, true);
});
