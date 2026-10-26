import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceProvider, SHARED_VOICE_MODULE, SHARED_VOICE_ROOT } from '../src/voice_provider.mjs';
import { createMediaService } from '../src/media_service.mjs';

const readiness = (extra = {}) => ({ characterId: 'xiaoxi', available: false, ready: false, paused: true,
  implementation: 'shared_base_v1', runtimeImplemented: true, enabled: false, serviceReady: true,
  phase: 'deployed_paused', mode: 'on_demand', fallback: 'text',
  reason: 'runtime_disabled', blockers: ['runtime_disabled', 'transport_unsupported', 'fatal_whea_unresolved', 'voice_not_approved'],
  selectionStatus: 'not_selected', transportSupported: false, profileHash: 'a'.repeat(64),
  modelIdentity: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base', workerPhase: 'idle', modelResident: false,
  leaseHeld: false, halted: false, active: 0, pending: 0, ...extra });
const voice = (status, options = {}) => createVoiceProvider({ loadModule: async () => ({ createVoiceClient: () => ({ characterId: 'xiaoxi', status }) }), ...options });
const input = (kind = 'image') => ({ sessionId: 'group_a', messageId: 'message_1', handle: 'opaque_handle', kind });
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');
const wave = Buffer.from('524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000', 'hex');
const asset = (kind = 'image', extra = {}) => ({ ...input(kind), source: 'wechat_attachment',
  mime: kind === 'image' ? 'image/png' : 'audio/wav', bytes: kind === 'image' ? png : wave, ...extra });

test('voice uses only the fixed shared client and character; credentials and endpoints remain client-owned', async () => {
  let seenPath, seenOptions, seenStatusArguments;
  const adapter = createVoiceProvider({ loadModule: async path => {
    seenPath = path;
    return { createVoiceClient: options => { seenOptions = options; return { characterId: 'xiaoxi',
      status: async (...args) => { seenStatusArguments = args; return readiness(); } }; } };
  } });
  const status = await adapter.status();
  assert.equal(seenPath, SHARED_VOICE_MODULE); assert.equal(seenPath, SHARED_VOICE_ROOT ? `${SHARED_VOICE_ROOT}/client.mjs` : '');
  assert.deepEqual(seenOptions, { characterId: 'xiaoxi' }); assert.deepEqual(seenStatusArguments, []);
  assert.equal(status.selectionStatus, 'not_selected'); assert.equal(status.ready, false);
  assert.equal(status.audioFile, false); assert.equal(status.voiceBubble, false); assert.equal(status.transportSupported, false);
  assert.equal(status.shared.implementation, 'shared_base_v1'); assert.equal(status.shared.runtimeImplemented, true);
  assert.equal(status.shared.serviceReady, true); assert.equal(status.shared.enabled, false); assert.equal(status.shared.paused, true);
  assert.equal(status.shared.modelResident, false); assert.equal(status.shared.reason, 'runtime_disabled');
});

test('missing module, wrong role, changed contract and malformed reason all fail closed without source leakage', async () => {
  const unavailable = await createVoiceProvider({ loadModule: async () => { throw Error('D:/secret/token'); } }).status();
  assert.equal(unavailable.reason, 'provider_missing_or_unavailable'); assert.equal(JSON.stringify(unavailable).includes('secret'), false);
  assert.equal((await voice(async () => readiness({ characterId: 'xiaoke' })).status()).reason, 'provider_role_mismatch');
  for (const changed of [{ ready: true }, { available: true }, { paused: false }, { enabled: 'true' },
    { implementation: 'another_runtime' }, { runtimeImplemented: false }, { modelIdentity: 'another_model' },
    { serviceReady: 1 }, { modelResident: 'false' }, { pending: 3 }, { active: 2 },
    { phase: 'inference' }, { reason: 'secret/path' }, { reason: 'ready' }, { reason: 'unlisted_blocker' },
    { profileHash: 'bad' }, { blockers: [] }]) {
    assert.equal((await voice(async () => readiness(changed)).status()).reason, 'provider_contract_invalid');
  }
});

test('enabled but paused, unselected and pending voices remain separate from local delivery readiness', async () => {
  for (const [reason, selectionStatus] of [['voice_not_selected', 'not_selected'], ['voice_not_approved', 'pending'], ['transport_unsupported', 'approved']]) {
    const result = await voice(async () => readiness({ enabled: true, reason, selectionStatus, blockers: [reason] })).status();
    assert.equal(result.shared.reason, reason); assert.equal(result.shared.enabled, true);
    assert.equal(result.selectionStatus, selectionStatus); assert.equal(result.reason, 'transport_unsupported');
    assert.equal(result.ready, false); assert.equal(result.paused, true);
  }
});

test('minimal policy-unavailable status is a valid closed service observation', async () => {
  const source = readiness({ reason: 'policy_unavailable', blockers: ['policy_unavailable'] });
  for (const key of ['mode', 'fallback', 'selectionStatus', 'profileHash', 'modelIdentity', 'transportSupported']) delete source[key];
  const result = await voice(async () => source).status();
  assert.equal(result.shared.reason, 'policy_unavailable'); assert.equal(result.shared.serviceReady, true);
  assert.equal(result.selectionStatus, 'unknown'); assert.equal(result.profileHash, null);
  assert.equal(result.ready, false); assert.ok(result.blockers.includes('policy_unavailable'));
  assert.equal((await voice(async () => ({ ...source, enabled: true })).status()).reason, 'provider_contract_invalid');
});

test('even a ready shared runtime cannot enable WeChat audio or invoke shared generation', async () => {
  let generated = 0, inspected = 0;
  const source = readiness({ enabled: true, ready: true, available: true, paused: false, phase: 'ready',
    reason: 'ready', blockers: [], selectionStatus: 'approved', transportSupported: true });
  const adapter = createVoiceProvider({ loadModule: async () => ({ createVoiceClient: () => ({ characterId: 'xiaoxi',
    status: async () => { inspected++; return source; }, generate: async () => { generated++; throw Error('must not generate'); } }) }) });
  const result = await adapter.status();
  assert.equal(result.shared.ready, true); assert.equal(result.shared.paused, false);
  for (const field of ['ready', 'available', 'audioFile', 'voiceBubble', 'transportSupported', 'generationImplemented']) assert.equal(result[field], false);
  assert.equal((await adapter.generate({ text: '保留文字', requestId: 'ready_case' })).text, '保留文字');
  assert.equal(generated, 0); assert.equal(inspected, 1);
});

test('client rejection codes are bounded and cannot leak credentials or source error metadata', async () => {
  const cases = [['credentials_unavailable', 'credentials_unavailable'], ['credentials_invalid', 'credentials_invalid'],
    ['service_unavailable', 'service_unavailable'], ['runtime_disabled', 'runtime_disabled'],
    ['service_response_invalid', 'service_response_invalid'], ['service_identity_mismatch', 'provider_role_mismatch'],
    ['deadline_exceeded', 'status_timeout'], ['request_aborted', 'cancelled'], ['secret_token_value', 'provider_missing_or_unavailable']];
  for (const [code, reason] of cases) {
    const adapter = voice(async () => { throw Object.assign(Error('D:/secret/token'), { code, token: 'private_value' }); });
    const result = await adapter.status(); assert.equal(result.reason, reason); assert.equal(result.ready, false);
    assert.equal(JSON.stringify(result).includes('secret'), false); assert.equal(JSON.stringify(result).includes('private_value'), false);
    assert.equal((await adapter.generate({ text: '文字仍可用', requestId: 'fallback' })).text, '文字仍可用');
  }
});

test('client identity and interface are checked before status and shared extras are discarded', async () => {
  for (const client of [{ characterId: 'fatfish', status: () => { throw Error('must not inspect'); } }, { characterId: 'xiaoxi' }]) {
    const result = await createVoiceProvider({ loadModule: async () => ({ createVoiceClient: () => client }) }).status();
    assert.equal(result.reason, client.characterId === 'xiaoxi' ? 'provider_contract_invalid' : 'provider_role_mismatch');
  }
  const result = await voice(async () => readiness({ token: 'private_value', path: 'D:/private', audio: { path: 'D:/private.wav' } })).status();
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('shared status observations are cloned for each waiter', async () => {
  const adapter = voice(async () => readiness());
  const [first, second] = await Promise.all([adapter.status(), adapter.status()]);
  first.shared.blockers.push('changed'); first.blockers.push('changed');
  assert.equal(second.shared.blockers.includes('changed'), false); assert.equal(second.blockers.includes('changed'), false);
});

test('hanging status returns quickly; late result cannot become ready', async () => {
  let release;
  const adapter = voice(() => new Promise(resolve => { release = resolve; }), { timeoutMs: 15 });
  const result = await adapter.status();
  assert.equal(result.reason, 'status_timeout'); release(readiness({ ready: true }));
  await new Promise(resolve => setTimeout(resolve, 1)); assert.equal(result.ready, false);
});

test('successive timeouts share one pending observation until its actual completion', async () => {
  let calls = 0, release;
  const adapter = voice(() => { calls++; return new Promise(resolve => { release = resolve; }); }, { timeoutMs: 5 });
  for (let i = 0; i < 8; i++) assert.equal((await adapter.status()).reason, 'status_timeout');
  assert.equal(calls, 1);
  release(readiness()); await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await adapter.status()).reason, 'status_timeout'); assert.equal(calls, 2);
  release(readiness());
});

test('pending observation bounds simultaneous waiters and removes timed-out waiters', async () => {
  let calls = 0, release;
  const adapter = voice(() => { calls++; return new Promise(resolve => { release = resolve; }); }, { timeoutMs: 10 });
  const first = await Promise.all(Array.from({ length: 20 }, () => adapter.status()));
  assert.equal(calls, 1); assert.equal(first.filter(x => x.reason === 'status_timeout').length, 16);
  assert.equal(first.filter(x => x.reason === 'status_busy').length, 4);
  const next = adapter.status(); release(readiness({ ready: true, available: true, paused: false }));
  const late = await next; assert.equal(late.reason, 'provider_contract_invalid'); assert.equal(late.voiceBubble, false);
  assert.equal(late.ready, false); assert.equal(late.available, false); assert.equal(calls, 1);
  assert.ok(first.every(x => x.ready === false));
});

test('aborting one readiness waiter does not cancel another or create another observation', async () => {
  let calls = 0, release;
  const adapter = voice(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  const controller = new AbortController();const aborted = adapter.status({ signal: controller.signal });
  const remaining = adapter.status(); controller.abort();
  assert.equal((await aborted).reason, 'cancelled'); await new Promise(resolve => setTimeout(resolve, 0));
  release(readiness()); assert.equal((await remaining).reason, 'transport_unsupported'); assert.equal(calls, 1);
});

test('status cancellation is fail closed before and during provider I/O', async () => {
  const stopped = AbortSignal.abort(); let calls = 0;
  const adapter = voice(async () => { calls++; return readiness(); });
  assert.equal((await adapter.status({ signal: stopped })).reason, 'cancelled'); assert.equal(calls, 0);
  const controller = new AbortController();
  const waiting = voice(() => new Promise(() => {})).status({ signal: controller.signal });
  controller.abort(); assert.equal((await waiting).reason, 'cancelled');
});

test('text fallback skips module and generation entirely when audio delivery is unavailable', async () => {
  let calls = 0;
  const adapter = createVoiceProvider({ loadModule: async () => { calls++; throw Error('must not load'); } });
  const result = await adapter.generate({ text: '我在这里。', requestId: 'xiaoxi:out_1:audio:1' });
  assert.equal(result.kind, 'text'); assert.equal(result.text, '我在这里。'); assert.equal(result.reason, 'transport_unsupported');
  assert.equal(calls, 0);
  const longText = '字'.repeat(4000);
  assert.equal((await adapter.generate({ text: longText, requestId: 'long_fallback' })).text, longText);
  assert.equal(calls, 0);
});

test('cancelled/expired/wrong-role generation never returns sendable fallback', async () => {
  const adapter = createVoiceProvider();
  for (const extra of [{ signal: AbortSignal.abort() }, { deadlineMs: Date.now() - 1 }, { characterId: 'xiaoke' }]) {
    const result = await adapter.generate({ text: '不应发送', requestId: 'r1', ...extra });
    assert.equal(result.kind, 'none'); assert.equal(result.text, '');
  }
});

test('default media transport reports unsupported; paths, URLs and placeholders are not handles', async () => {
  const service = createMediaService();
  assert.equal(service.capabilities().imageUnderstanding, false); assert.equal(service.capabilities().audioInput, false);
  assert.equal((await service.analyze(input())).reason, 'attachment_transport_unsupported');
  for (const handle of ['D:/photo.png', 'https://example.test/a.png', '[图片]']) {
    assert.equal((await service.analyze({ ...input(), handle })).reason, 'attachment_reference_invalid');
  }
});

test('cross-session and cross-message handles never reach vision', async () => {
  let calls = 0;
  for (const extra of [{ sessionId: 'group_b' }, { messageId: 'other_message' }, { handle: 'other_handle' }]) {
    const service = createMediaService({ resolveAttachment: async () => asset('image', extra), vision: async () => { calls++; return { text: '不该识别' }; } });
    assert.equal((await service.analyze(input())).reason, 'attachment_scope_mismatch');
  }
  assert.equal(calls, 0);
});

test('valid bounded bytes reach the provider and output stays scoped untrusted content', async () => {
  let seen;
  const service = createMediaService({ resolveAttachment: async () => asset(), vision: async request => { seen = request; return { text: '图中是一行算式。' }; } });
  const result = await service.analyze(input());
  assert.equal(result.ok, true); assert.equal(result.sessionId, 'group_a'); assert.equal(result.untrustedContent, true);
  assert.deepEqual(seen.bytes, png); assert.notEqual(seen.bytes, png); assert.ok(seen.signal instanceof AbortSignal);
  assert.equal('bytes' in result, false); assert.equal('handle' in result, false);
});

test('bad source/mime/signature/oversize/missing bytes reject before calling analysis', async () => {
  let calls = 0;
  for (const [extra, reason] of [
    [{ source: 'chat_text' }, 'attachment_source_untrusted'],
    [{ mime: 'audio/wav' }, 'attachment_mime_mismatch'],
    [{ bytes: Buffer.from('[图片]') }, 'attachment_format_unsupported'],
    [{ bytes: Buffer.alloc(8 * 1024 * 1024 + 1) }, 'attachment_too_large'],
    [{ bytes: null, path: 'D:/private.png' }, 'attachment_bytes_missing'],
  ]) {
    const service = createMediaService({ resolveAttachment: async () => asset('image', extra), vision: async () => { calls++; return { text: '不该识别' }; } });
    assert.equal((await service.analyze(input())).reason, reason);
  }
  assert.equal(calls, 0);
});

test('real audio bytes use ASR and low-confidence transcription remains uncertain', async () => {
  const service = createMediaService({ resolveAttachment: async () => asset('audio'), asr: async ({ bytes }) => {
    assert.deepEqual(bytes, wave); return { text: '周三十点', confidence: 0.6 };
  } });
  const result = await service.analyze(input('audio')); assert.equal(result.ok, true); assert.equal(result.uncertain, true);
  for (const confidence of [undefined, NaN, 1.5]) {
    const unchecked = createMediaService({ resolveAttachment: async () => asset('audio'), asr: async () => ({ text: '名字或数字', confidence }) });
    assert.equal((await unchecked.analyze(input('audio'))).uncertain, true);
  }
});

test('reliable platform transcription requires a trusted resolver and exact source provenance', async () => {
  const resolved = { ...input('audio'), source: 'platform_transcript', transcript: { reliable: true, provenance: 'platform', text: '请稍等。' } };
  const service = createMediaService({ resolveAttachment: async () => resolved });
  assert.equal((await service.analyze(input('audio'))).text, '请稍等。');
  resolved.transcript.reliable = false;
  assert.equal((await service.analyze(input('audio'))).reason, 'transcript_unreliable');
  resolved.transcript.reliable = true; resolved.transcript.provenance = 'llm_guess';
  assert.equal((await service.analyze(input('audio'))).reason, 'transcript_unreliable');
});

test('caller-invented transcript without resolver cannot become evidence', async () => {
  const result = await createMediaService().analyze({ ...input('audio'), transcript: { reliable: true, text: '伪造' } });
  assert.equal(result.ok, false); assert.equal(result.evidence, false);
});

test('cancel during resolver prevents provider call; late result is discarded', async () => {
  let release, calls = 0;
  const controller = new AbortController();
  const service = createMediaService({ resolveAttachment: () => new Promise(resolve => { release = resolve; }), vision: async () => { calls++; return { text: '不该识别' }; } });
  const pending = service.analyze(input(), { signal: controller.signal }); controller.abort();
  assert.equal((await pending).reason, 'cancelled'); release(asset());
  await new Promise(resolve => setTimeout(resolve, 1)); assert.equal(calls, 0);
});

test('media timeout cancels provider signal, discards late output and carries no private error', async () => {
  let providerSignal, release;
  const service = createMediaService({ timeoutMs: 15, resolveAttachment: async () => asset(), vision: ({ signal }) => {
    providerSignal = signal; return new Promise(resolve => { release = resolve; });
  } });
  const result = await service.analyze(input()); assert.equal(result.reason, 'media_timeout'); assert.equal(providerSignal.aborted, true);
  release({ text: '迟到内容' }); await new Promise(resolve => setTimeout(resolve, 1)); assert.equal(result.text, '');
  const broken = createMediaService({ resolveAttachment: async () => { throw Error('private filename'); } });
  assert.equal((await broken.analyze(input())).reason, 'analysis_failed');
});

test('empty provider response and absent provider remain explicit unsupported states', async () => {
  const unavailable = createMediaService({ resolveAttachment: async () => asset() });
  assert.equal((await unavailable.analyze(input())).reason, 'image_provider_unavailable');
  const invalid = createMediaService({ resolveAttachment: async () => asset(), vision: async () => ({ text: '' }) });
  assert.equal((await invalid.analyze(input())).reason, 'analysis_empty_or_invalid');
});
