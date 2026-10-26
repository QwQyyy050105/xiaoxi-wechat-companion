import { pathToFileURL } from 'node:url';

// Application-owned constants, never a renderer/model supplied role or path.
export const SHARED_VOICE_ROOT = process.env.XIAOXI_VOICE_ROOT || '';
export const SHARED_VOICE_MODULE = process.env.XIAOXI_VOICE_MODULE || (SHARED_VOICE_ROOT ? `${SHARED_VOICE_ROOT}/client.mjs` : '');
export const VOICE_CHARACTER_ID = 'xiaoxi';

function closed(reason = 'status_not_checked') {
  return {
    characterId: VOICE_CHARACTER_ID, available: false, ready: false, paused: true,
    phase: 'readiness_only', generationImplemented: false, mode: 'on_demand', fallback: 'text',
    transportSupported: false, audioFile: false, voiceBubble: false,
    selectionStatus: 'unknown', profileHash: null, reason, blockers: [reason], shared: null,
  };
}

const token = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(value);
const MODEL_ID = 'Qwen/Qwen3-TTS-12Hz-1.7B-Base';
const CLIENT_ERRORS = new Set(['credentials_unavailable', 'credentials_invalid', 'service_unavailable',
  'service_response_invalid', 'runtime_disabled', 'runtime_closed', 'worker_halted', 'policy_unavailable']);

function sharedObservation(source) {
  if (source?.characterId !== VOICE_CHARACTER_ID) throw Error('provider_role_mismatch');
  const policyUnavailable = source.reason === 'policy_unavailable';
  const invalid = () => { throw Error('provider_contract_invalid'); };
  if (source.implementation !== 'shared_base_v1' || source.runtimeImplemented !== true ||
      !['enabled', 'available', 'ready', 'paused', 'serviceReady', 'modelResident', 'leaseHeld', 'halted']
        .every(key => typeof source[key] === 'boolean') ||
      !['deployed_paused', 'ready'].includes(source.phase) || !token(source.reason) ||
      !Array.isArray(source.blockers) || source.blockers.length > 32 || !source.blockers.every(token) ||
      !token(source.workerPhase) || ![0, 1].includes(source.active) ||
      !Number.isInteger(source.pending) || source.pending < 0 || source.pending > 2 ||
      source.available !== source.ready || source.paused === source.ready) invalid();
  if (source.ready) {
    if (!source.enabled || !source.serviceReady || source.halted || source.phase !== 'ready' ||
        source.reason !== 'ready' || source.blockers.length || source.selectionStatus !== 'approved' ||
        source.transportSupported !== true) invalid();
  } else if (source.phase !== 'deployed_paused' || source.reason === 'ready' ||
      !source.blockers.length || !source.blockers.includes(source.reason)) invalid();
  // The service deliberately omits profile details when policy inspection fails.
  if (policyUnavailable && (source.ready || source.enabled || !source.blockers.includes('policy_unavailable'))) invalid();
  if ((!policyUnavailable || source.mode !== undefined) && source.mode !== 'on_demand') invalid();
  if ((!policyUnavailable || source.fallback !== undefined) && source.fallback !== 'text') invalid();
  if ((!policyUnavailable || source.modelIdentity !== undefined) && source.modelIdentity !== MODEL_ID) invalid();
  if ((!policyUnavailable || source.selectionStatus !== undefined) &&
      !['unknown', 'not_selected', 'pending', 'rejected', 'approved'].includes(source.selectionStatus)) invalid();
  if ((!policyUnavailable || source.transportSupported !== undefined) && typeof source.transportSupported !== 'boolean') invalid();
  if ((!policyUnavailable || source.profileHash !== undefined) && !/^[a-f0-9]{64}$/.test(source.profileHash ?? '')) invalid();
  // Allowlisted diagnostics only; shared readiness never grants local delivery.
  return { implementation: source.implementation, runtimeImplemented: true,
    serviceReady: source.serviceReady, enabled: source.enabled, ready: source.ready, paused: source.paused,
    phase: source.phase, reason: source.reason, blockers: [...new Set(source.blockers)],
    selectionStatus: source.selectionStatus ?? 'unknown', profileHash: source.profileHash ?? null,
    transportSupported: source.transportSupported ?? false, modelIdentity: source.modelIdentity ?? null,
    modelResident: source.modelResident, workerPhase: source.workerPhase, leaseHeld: source.leaseHeld,
    halted: source.halted, active: source.active, pending: source.pending };
}

const MAX_STATUS_WAITERS = 16;

/**
 * Read-only shared client adapter. loadModule is a test seam owned by code;
 * it must never be exposed in IPC, settings, model tools or user input.
 * Current WeChat transport has neither verified audio-file nor voice-bubble send.
 * Consequently generate returns a text plan without invoking shared.generate.
 */
export function createVoiceProvider({ timeoutMs = 750, loadModule = () => import(pathToFileURL(SHARED_VOICE_MODULE).href) } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000 || typeof loadModule !== 'function') {
    throw new TypeError('invalid voice adapter options');
  }
  let providerPromise, pendingObservation;
  const provider = async () => {
    if (!providerPromise) {
      providerPromise = Promise.resolve().then(() => loadModule(SHARED_VOICE_MODULE)).then(module => {
        if (typeof module?.createVoiceClient !== 'function') throw new Error('provider_contract_invalid');
        const loaded = module.createVoiceClient({ characterId: VOICE_CHARACTER_ID });
        if (loaded?.characterId !== VOICE_CHARACTER_ID) throw new Error('provider_role_mismatch');
        if (typeof loaded?.status !== 'function') throw new Error('provider_contract_invalid');
        return loaded;
      }).catch(error => { providerPromise = null; throw error; });
    }
    return providerPromise;
  };
  async function inspect() {
    try {
      const shared = sharedObservation(await (await provider()).status());
      return { ...closed('transport_unsupported'), shared,
        selectionStatus: shared.selectionStatus, profileHash: shared.profileHash,
        blockers: [...new Set(['transport_unsupported', ...shared.blockers])],
        pauseReason: shared.paused ? shared.reason : 'transport_unsupported' };
    } catch (error) {
      const code = error?.code;
      const reason = ['provider_contract_invalid', 'provider_role_mismatch'].includes(error?.message)
        ? error.message : code === 'service_identity_mismatch' ? 'provider_role_mismatch'
        : code === 'deadline_exceeded' ? 'status_timeout' : code === 'request_aborted' ? 'cancelled'
        : CLIENT_ERRORS.has(code) ? code : 'provider_missing_or_unavailable';
      return closed(reason);
    }
  }
  function observe() {
    if (pendingObservation) return pendingObservation;
    const observation = { waiters: new Set() };
    pendingObservation = observation;
    // Exactly one completion handler is attached to the underlying operation.
    // Timeout/abort removes a bounded waiter but never resets this observation;
    // a stuck filesystem read therefore cannot multiply on repeated polling.
    void inspect().then(result => {
      if (pendingObservation === observation) pendingObservation = null;
      for (const finish of [...observation.waiters]) finish(result);
    });
    return observation;
  }
  function status({ signal } = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.resolve(closed('request_invalid'));
    if (signal?.aborted) return Promise.resolve(closed('cancelled'));
    const observation = observe();
    if (observation.waiters.size >= MAX_STATUS_WAITERS) return Promise.resolve(closed('status_busy'));
    return new Promise(resolve => {
      let finished = false, timer;
      const onAbort = () => finish(closed('cancelled'));
      const finish = result => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        observation.waiters.delete(finish);
        resolve(structuredClone(result));
      };
      observation.waiters.add(finish);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(closed('status_timeout')), timeoutMs);
    });
  }
  async function generate(request) {
    const { text, requestId, signal, deadlineMs, characterId = VOICE_CHARACTER_ID } = request ?? {};
    if (characterId !== VOICE_CHARACTER_ID || typeof text !== 'string' || !text.trim() || text.includes('\0') ||
        text.length > 4000 || typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId) ||
        (signal !== undefined && !(signal instanceof AbortSignal)) ||
        (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0))) {
      return { ok: false, kind: 'none', text: '', reason: 'request_invalid', cancelled: false };
    }
    if (signal?.aborted) return { ok: false, kind: 'none', text: '', reason: 'cancelled', cancelled: true };
    // Shared contract uses an absolute epoch deadline, not a duration.
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      return { ok: false, kind: 'none', text: '', reason: 'deadline_exceeded', cancelled: true };
    }
    return { ok: false, kind: 'text', text, requestId, characterId: VOICE_CHARACTER_ID,
      reason: 'transport_unsupported', cancelled: false };
  }
  return Object.freeze({ status, generate });
}
