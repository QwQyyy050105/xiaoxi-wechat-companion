const ID = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
const HANDLE = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const IMAGE_LIMIT = 8 * 1024 * 1024;
const AUDIO_LIMIT = 20 * 1024 * 1024;
const TEXT_LIMIT = 12000;
const SOURCES = new Set(['wechat_attachment', 'owner_upload', 'platform_transcript']);

function unsupported(kind, reason) { return { ok: false, kind, reason, text: '', evidence: false }; }
function checkAbort(signal) { if (signal.aborted) throw new Error(signal.reason === 'media_timeout' ? 'media_timeout' : 'cancelled'); }

function hasMagic(bytes, mime) {
  const start = bytes.subarray(0, 16);
  const ascii = start.toString('ascii');
  switch (mime) {
    case 'image/png': return start.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'image/jpeg': return start[0] === 0xff && start[1] === 0xd8 && start[2] === 0xff;
    case 'image/gif': return ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a');
    case 'image/webp': return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
    case 'audio/wav': case 'audio/x-wav': return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE';
    case 'audio/ogg': return ascii.startsWith('OggS');
    case 'audio/mpeg': return ascii.startsWith('ID3') || (start[0] === 0xff && (start[1] & 0xe0) === 0xe0);
    case 'audio/mp4': return ascii.slice(4, 8) === 'ftyp';
    default: return false;
  }
}

/**
 * No filesystem/network/model implementation exists here. A trusted attachment
 * resolver must bind each opaque handle to its originating session and message.
 * Raw URLs, paths, placeholder strings and caller-supplied transcripts are not
 * evidence. Providers receive actual bounded bytes and a cancellation signal.
 * Their output is untrusted quoted content, never a command or memory mutation.
 */
export function createMediaService({ resolveAttachment, vision, asr, timeoutMs = 5000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
      [resolveAttachment, vision, asr].some(value => value !== undefined && typeof value !== 'function')) {
    throw new TypeError('invalid media service options');
  }
  const capabilities = () => ({
    imageInput: Boolean(resolveAttachment), audioInput: Boolean(resolveAttachment),
    imageUnderstanding: Boolean(resolveAttachment && vision), audioTranscription: Boolean(resolveAttachment && asr),
    platformTranscript: Boolean(resolveAttachment), audioFile: false, voiceBubble: false,
  });
  async function analyze(input, { signal } = {}) {
    const { sessionId, messageId, handle, kind } = input ?? {};
    if (!['image', 'audio'].includes(kind) || !ID(sessionId) || !ID(messageId) || !HANDLE(handle)) {
      return unsupported(kind, 'attachment_reference_invalid');
    }
    if (signal?.aborted) return unsupported(kind, 'cancelled');
    if (!resolveAttachment) return unsupported(kind, 'attachment_transport_unsupported');
    const controller = new AbortController();
    let timer, rejectStop;
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    const stop = reason => { controller.abort(reason); rejectStop(new Error(reason)); };
    const onAbort = () => stop('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop('media_timeout'), timeoutMs);
    const work = async () => {
      const asset = await resolveAttachment({ sessionId, messageId, handle, kind, signal: controller.signal });
      checkAbort(controller.signal);
      if (!asset || asset.sessionId !== sessionId || asset.messageId !== messageId || asset.handle !== handle) {
        return unsupported(kind, 'attachment_scope_mismatch');
      }
      if (!SOURCES.has(asset.source)) return unsupported(kind, 'attachment_source_untrusted');
      if (kind === 'audio' && asset.source === 'platform_transcript') {
        const transcript = asset.transcript;
        if (transcript?.reliable !== true || transcript.provenance !== 'platform' ||
            typeof transcript.text !== 'string' || !transcript.text.trim() || transcript.text.length > TEXT_LIMIT || transcript.text.includes('\0')) {
          return unsupported(kind, 'transcript_unreliable');
        }
        return { ok: true, kind, text: transcript.text.trim(), evidence: true, source: 'platform_transcript',
          sessionId, messageId, uncertain: transcript.uncertain === true, untrustedContent: true };
      }
      if (asset.source === 'platform_transcript') return unsupported(kind, 'attachment_source_untrusted');
      if (!(asset.bytes instanceof Uint8Array) || asset.bytes.byteLength === 0) return unsupported(kind, 'attachment_bytes_missing');
      const limit = kind === 'image' ? IMAGE_LIMIT : AUDIO_LIMIT;
      if (asset.bytes.byteLength > limit) return unsupported(kind, 'attachment_too_large');
      if (typeof asset.mime !== 'string' || !asset.mime.startsWith(`${kind}/`)) return unsupported(kind, 'attachment_mime_mismatch');
      // Detach a bounded copy so a resolver cannot mutate bytes after validation.
      const bytes = Buffer.from(asset.bytes);
      if (!hasMagic(bytes, asset.mime)) return unsupported(kind, 'attachment_format_unsupported');
      const provider = kind === 'image' ? vision : asr;
      if (!provider) return unsupported(kind, `${kind}_provider_unavailable`);
      const result = await provider({ bytes, mime: asset.mime, sessionId, messageId, signal: controller.signal });
      checkAbort(controller.signal);
      if (typeof result?.text !== 'string' || !result.text.trim() || result.text.length > TEXT_LIMIT || result.text.includes('\0')) {
        return unsupported(kind, 'analysis_empty_or_invalid');
      }
      return { ok: true, kind, text: result.text.trim(), evidence: true, source: asset.source, sessionId, messageId,
        uncertain: result.uncertain === true || (kind === 'audio' &&
          !(Number.isFinite(result.confidence) && result.confidence >= 0.85 && result.confidence <= 1)) ||
          (Number.isFinite(result.confidence) && result.confidence < 0.85),
        untrustedContent: true };
    };
    try { return await Promise.race([work(), stopped]); }
    catch (error) { return unsupported(kind, ['cancelled', 'media_timeout'].includes(error?.message) ? error.message : 'analysis_failed'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
  return Object.freeze({ capabilities, analyze });
}
