import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PersonaLoader, PersonaLoadError, PERSONA_SOURCE, MAX_PERSONA_BYTES} from '../src/persona_loader.mjs';

const valid = () => ({schema_version: 2, id: 'xiaoxi', name: '小汐', identity: '独立的AI伙伴', core: ['有自己的判断'], voice: ['自然聊天'],
  preferences: ['喜欢雨后'], emotion: {basis: '当前可见对话', transitions: ['转认真时收住玩笑'], scope: '当前会话'},
  continuity: ['承接当前对话'], examples: [{user: '小汐', reply: '嗯？'}],
  dialogue_examples: [{scene: '短暂招呼', turns: [{user: '在吗', reply: '在'}]}]});
function fixture(t) {
  const parent = path.resolve('temp'); assert.ok(path.isAbsolute(parent)); fs.mkdirSync(parent, {recursive: true});
  const root = fs.mkdtempSync(path.join(parent, 'persona_loader_test_'));
  t.after(() => {const resolved = path.resolve(root); assert.ok(resolved.startsWith(parent + path.sep)); fs.rmSync(resolved, {recursive: true, force: true});});
  let now = Date.parse('2026-10-24T12:00:00Z');
  const filename = path.join(root, PERSONA_SOURCE), loader = new PersonaLoader(root, {nowMs: () => now});
  return {root, filename, loader, advance: () => now += 1000,
    write: value => fs.writeFileSync(filename, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))};
}

test('loads the fixed card with a raw-content hash and metadata but no card text in status', t => {
  const f = fixture(t), card = valid(); f.write(card);
  const {persona, status} = f.loader.load();
  assert.deepEqual(persona, card); assert.equal(status.source, 'character_card.json');
  assert.equal(status.sha256, createHash('sha256').update(fs.readFileSync(f.filename)).digest('hex'));
  assert.equal(status.schemaVersion, 2); assert.equal(status.revision, 1); assert.equal(status.reload, 'loaded');
  assert.equal(status.lastError, null); assert.equal(status.loadedAt, '2026-10-24T12:00:00.000Z');
  assert.ok(!JSON.stringify(status).includes(card.core[0]));
});

test('unchanged reload does not invent a revision and returned snapshots cannot mutate the cache', t => {
  const f = fixture(t); f.write(valid()); const initial = f.loader.load();
  initial.persona.core[0] = 'caller mutation'; initial.status.sha256 = 'wrong'; f.advance();
  const next = f.loader.load(); assert.equal(next.persona.core[0], valid().core[0]);
  assert.equal(next.status.revision, 1); assert.equal(next.status.reload, 'unchanged');
  assert.equal(next.status.loadedAt, initial.status.loadedAt); assert.notEqual(next.status.lastCheckedAt, initial.status.lastCheckedAt);
  const status = f.loader.status; status.lastError = 'external'; assert.equal(f.loader.status.lastError, null);
});

test('valid replacement commits the entire new persona, hash and revision together', t => {
  const f = fixture(t); f.write(valid()); const old = f.loader.load(); f.advance();
  const card = valid(); card.core = ['新的表达方式']; card.preferences = ['新的偏好']; f.write(card);
  const next = f.loader.reload(); assert.deepEqual(next.persona, card); assert.equal(next.status.revision, 2);
  assert.notEqual(next.status.sha256, old.status.sha256); assert.notEqual(next.status.loadedAt, old.status.loadedAt);
  assert.equal(next.status.reload, 'reloaded'); assert.equal(next.status.lastError, null);
});

test('a partial JSON write retains the complete previous card and a generic diagnostic', t => {
  const f = fixture(t); f.write(valid()); const old = f.loader.load(); f.advance();
  f.write('{"id":"xiaoxi","secret_marker":"DO_NOT_EXPOSE"');
  const retained = f.loader.reload(); assert.deepEqual(retained.persona, old.persona);
  for (const key of ['sha256', 'revision', 'loadedAt', 'schemaVersion']) assert.equal(retained.status[key], old.status[key]);
  assert.equal(retained.status.reload, 'retained_previous'); assert.equal(retained.status.lastError.code, 'invalid_json');
  assert.ok(!JSON.stringify(retained.status).includes('DO_NOT_EXPOSE'));
  f.write(valid()); f.advance(); const recovered = f.loader.reload();
  assert.equal(recovered.status.reload, 'unchanged'); assert.equal(recovered.status.lastError, null);
});

test('missing first load fails explicitly, then a later valid card can recover without a default persona', t => {
  const f = fixture(t);
  assert.throws(() => f.loader.load(), error => error instanceof PersonaLoadError && error.code === 'source_unavailable' && error.status.revision === 0);
  assert.equal(f.loader.status.reload, 'unavailable'); assert.equal(f.loader.status.sha256, null);
  f.write(valid()); assert.equal(f.loader.load().status.revision, 1);
});

test('missing or directory replacement retains the last valid card', t => {
  const f = fixture(t); f.write(valid()); const old = f.loader.load(); fs.unlinkSync(f.filename);
  assert.deepEqual(f.loader.reload().persona, old.persona);
  assert.equal(f.loader.status.lastError.code, 'source_unavailable');
  fs.mkdirSync(f.filename); assert.deepEqual(f.loader.reload().persona, old.persona);
  assert.equal(f.loader.status.lastError.code, 'source_not_file');
});

test('wrong character, unsupported schema and malformed expression fields are never accepted', t => {
  const f = fixture(t); f.write(valid()); const old = f.loader.load();
  const mutations = [
    card => card.id = 'other', card => card.name = '', card => card.schema_version = 0,
    card => card.schema_version = 1001, card => card.schema_version = 1.5, card => card.schema_version = '3',
    card => card.identity = [], card => card.core = [], card => card.voice = 'should be an array',
    card => card.preferences = [42], card => card.emotion = 'not an object',
    card => card.emotion.transitions = [false], card => card.continuity = {}, card => card.typing = {},
    card => card.examples = [{user: 'hi'}], card => card.dialogue_examples[0].turns[0].reply = {},
    card => card.voice_profile = {status: 1}, card => card.core = ['x'.repeat(8001)]
  ];
  for (const mutate of mutations) {
    const card = valid(); mutate(card); f.write(card);
    const result = f.loader.reload(); assert.deepEqual(result.persona, old.persona);
    assert.equal(result.status.reload, 'retained_previous'); assert.equal(result.status.revision, 1);
  }
});

test('invalid initial shapes do not silently construct a fallback identity', t => {
  for (const value of ['null', '[]', '{}', '{"schema_version":2,"id":"other","name":"小汐"}']) {
    const f = fixture(t); f.write(value);
    assert.throws(() => f.loader.load(), PersonaLoadError); assert.equal(f.loader.status.revision, 0);
  }
});

test('future positive schema versions keep the same identity and expression validation', t => {
  const f = fixture(t), card = valid(); card.schema_version = 42; card.typing = ['短句也可以自然结束']; f.write(card);
  const result = f.loader.load(); assert.equal(result.status.schemaVersion, 42); assert.deepEqual(result.persona.typing, card.typing);
});

test('a file changed during the bounded read cannot replace the previous persona', t => {
  const f = fixture(t); f.write(valid()); const old = f.loader.load();
  const next = valid(); next.core = ['尚未稳定的新内容']; f.write(next);
  const original = fs.readSync; let changed = false;
  fs.readSync = function (...args) {
    const count = original.apply(this, args);
    if (!changed) { changed = true; fs.appendFileSync(f.filename, ' '); }
    return count;
  };
  let result;
  try { result = f.loader.reload(); } finally { fs.readSync = original; }
  assert.deepEqual(result.persona, old.persona); assert.equal(result.status.lastError.code, 'source_changed');
  assert.equal(result.status.revision, 1);
  assert.equal(f.loader.reload().status.revision, 2);
});

test('the 128KiB byte bound accepts the boundary and rejects any extra byte', t => {
  const f = fixture(t), json = Buffer.from(JSON.stringify(valid()));
  const boundary = Buffer.concat([json, Buffer.alloc(MAX_PERSONA_BYTES - json.length, 32)]); f.write(boundary);
  assert.equal(f.loader.load().status.reload, 'loaded');
  f.write(Buffer.concat([boundary, Buffer.from(' ')]));
  assert.equal(f.loader.reload().status.lastError.code, 'source_too_large');
  assert.equal(f.loader.status.revision, 1);
});

test('invalid UTF-8 is rejected without replacing a previously valid card', t => {
  const f = fixture(t); f.write(valid()); const old = f.loader.load(); f.write(Buffer.from([0xff, 0xfe, 0x7b]));
  assert.deepEqual(f.loader.reload().persona, old.persona); assert.equal(f.loader.status.lastError.code, 'invalid_encoding');
});

test('reference-like metadata is data only and does not load another file', t => {
  const f = fixture(t), card = valid();
  card.include = 'missing_external_persona.json'; card.reference = {path: '../../outside.json', url: 'https://invalid.example/card.json'};
  f.write(card); const loaded = f.loader.load(); assert.deepEqual(loaded.persona, card);
  assert.equal(loaded.status.source, PERSONA_SOURCE); assert.equal(loaded.status.lastError, null);
  assert.deepEqual(fs.readdirSync(f.root), [PERSONA_SOURCE]);
});

test('the deployed public card satisfies the loader schema in an isolated fixture', t => {
  const f = fixture(t); f.write(fs.readFileSync(path.resolve(PERSONA_SOURCE)));
  const loaded = f.loader.load(); assert.equal(loaded.persona.id, 'xiaoxi'); assert.equal(loaded.persona.name, '小汐');
  assert.equal(loaded.status.reload, 'loaded');
});
