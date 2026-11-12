// Mixed batches can answer a later text instead of the spoken message.
export function standaloneVoiceRequest(events) {
  if (events.length !== 1) return null;
  const [request] = events;
  return ['platform_transcript','asr_transcript'].includes(request.inputModality?.kind) ? request : null;
}

// A reply can span multiple chat bubbles. Only the built-in transport can supply
// a native observation, and a partial echo cannot confirm the whole reply.
export function summarizeVoiceDelivery(inputAt, expectedParts, observations, finishedAt, nativeVoiceWindowMinimized) {
  if (!Number.isFinite(inputAt) || !observations.length || !expectedParts) return null;
  const echoes = observations.filter(part => part.status === 'local_echo');
  const echoed = echoes.length;
  const unknown = observations.some(part => part.status === 'unknown');
  const status = echoed === expectedParts ? 'local_echo' : echoed ? 'partial' : unknown ? 'unknown' : 'not_sent';
  const foreground = observations.map(part => part.wechatForegroundObserved);
  return {
    observedAt: new Date(inputAt).toISOString(),
    ...(typeof nativeVoiceWindowMinimized==='boolean' ? {inputSource:'wechat_platform_transcript',inputWindowMinimized:nativeVoiceWindowMinimized} : {}),
    finishedAt: new Date(finishedAt).toISOString(),
    status, expectedParts, confirmedParts: echoed,
    ...(echoed && echoes.every(part=>part.echoEvidence==='unique_text_and_cleared_draft') ? {
      echoEvidence:'unique_text_and_cleared_draft',
      echoAuthor:echoes.every(part=>part.echoAuthor==='self')?'self':'unavailable',
    } : {}),
    wechatForegroundObserved: foreground.includes(true) ? true : foreground.length === expectedParts && foreground.every(value => value === false) ? false : null,
    recipientReceipt: 'unavailable',
  };
}
