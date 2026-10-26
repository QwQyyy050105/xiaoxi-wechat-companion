// Ephemeral, per-session observations. Never reads or persists chat history.
export function senderEvidence(sender) {
  const value = sender && typeof sender === 'object' ? sender : {};
  const label = typeof value.label === 'string' ? value.label.slice(0, 120) : null;
  const verified = ['stable_id', 'platform_id', 'verified'].includes(value.evidence) && typeof value.id === 'string' && !!value.id && value.id.length <= 256;
  return {id: verified ? value.id.slice(0, 256) : null, label, evidence: verified ? 'stable_id' : label ? 'display_name' : 'unknown'};
}

export function sameVerifiedSender(a, b) {
  const left = senderEvidence(a?.sender ?? a), right = senderEvidence(b?.sender ?? b);
  return left.evidence === 'stable_id' && right.evidence === 'stable_id' && left.id === right.id;
}

function timestamp(value, fallback) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class ConversationContext {
  constructor({nowMs = Date.now, maxMessages = 200, maxAgeMs = 120 * 60 * 1000, maxChars = 24000} = {}) {
    this.nowMs = nowMs; this.maxMessages = maxMessages; this.maxAgeMs = maxAgeMs; this.maxChars = maxChars; this.sessions = new Map();
  }
  room(sessionId) {
    if (!sessionId) throw Error('A session ID is required');
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, {generation: 0, messages: [], dropped: 0, reason: 'new_session', startedAt: this.nowMs()});
    return this.sessions.get(sessionId);
  }
  generation(sessionId) { return this.room(sessionId).generation; }
  clear(sessionId, reason = 'reset') {
    const room = this.room(sessionId);
    Object.assign(room, {generation: room.generation + 1, messages: [], dropped: 0, reason, startedAt: this.nowMs()});
    return room.generation;
  }
  clearAll(reason = 'disconnect') { for (const key of this.sessions.keys()) this.clear(key, reason); }
  prune(room) {
    const cutoff = this.nowMs() - this.maxAgeMs;
    const kept = room.messages.filter(event => event.receivedAt >= cutoff);
    room.dropped += room.messages.length - kept.length;
    if (kept.length > this.maxMessages) { room.dropped += kept.length - this.maxMessages; kept.splice(0, kept.length - this.maxMessages); }
    room.messages = kept;
  }
  observe(sessionId, event = {}) {
    const room = this.room(sessionId); this.prune(room);
    if (event.generation !== undefined && event.generation !== room.generation) return null;
    const observationMode = event.observationMode === 'baseline' ? 'baseline' : 'live';
    const role = observationMode === 'baseline' ? (event.role === 'user' ? 'user' : 'unknown') : (event.role === 'assistant' ? 'assistant' : 'user');
    // A prepared/unknown answer has not been established as something the bot said.
    if (role === 'assistant' && !['local_echo', 'confirmed'].includes(event.deliveryStatus ?? event.status)) return null;
    const id = String(event.id ?? event.sourceKey ?? '');
    const sourceKey = String(event.sourceKey ?? id);
    if (!id || !sourceKey || room.messages.some(item => item.sourceKey === sourceKey)) return null;
    const receivedAt = Math.min(timestamp(event.receivedAt ?? event.createdAt ?? event.created, this.nowMs()), this.nowMs());
    if (receivedAt < this.nowMs() - this.maxAgeMs) { room.dropped++; return null; }
    const text = typeof event.text === 'string' ? event.text : '';
    const rawQuote = event.quote && typeof event.quote === 'object' ? event.quote : null;
    const quoteResolved = rawQuote?.verified === true && rawQuote.status === 'resolved' && typeof rawQuote.text === 'string';
    const quote = rawQuote ? {
      sourceKey: typeof rawQuote.sourceKey === 'string' ? rawQuote.sourceKey : null,
      status: quoteResolved ? 'resolved' : 'missing', verified: quoteResolved,
      text: quoteResolved ? rawQuote.text.slice(0, this.maxChars) : null,
      sender: senderEvidence(rawQuote.sender), authorIsBot: quoteResolved && rawQuote.authorIsBot === true,
      truncated: quoteResolved && rawQuote.text.length > this.maxChars
    } : null;
    const replySource=role==='assistant'&&typeof event.inReplyToSourceKey==='string'
      ?room.messages.find(item=>item.sourceKey===event.inReplyToSourceKey&&item.role==='user'&&item.observationMode==='live'):null;
    const entry = {
      id, sourceKey, generation: room.generation, receivedAt, observationMode,
      platformTime: observationMode === 'live' && event.platformTimeVerified === true ? timestamp(event.platformTime, null) : null,
      timeSource: observationMode === 'baseline' ? 'observed' : event.platformTimeVerified === true && timestamp(event.platformTime, null) !== null ? 'platform' : 'received',
      sender: senderEvidence(event.sender), role, text: text.slice(0, this.maxChars), textTruncated: text.length > this.maxChars,
      ...(event.inputModality?.kind==='platform_transcript'&&event.inputModality.provenance==='wechat_accessibility'?{inputModality:{kind:'platform_transcript',provenance:'wechat_accessibility',uncertain:true,durationSeconds:event.inputModality.durationSeconds}}:{}),
      quote, attachments: Array.isArray(event.attachments) ? event.attachments.slice(0, 10).map(item => ({
        kind: typeof item.kind === 'string' ? item.kind.slice(0, 30) : 'unknown',
        resourceId: typeof item.resourceId === 'string' ? item.resourceId.slice(0, 256) : null,
        available: item.available === true, sourceKey
      })) : [],
      ...(role === 'assistant' ? {deliveryStatus: event.deliveryStatus ?? event.status,...(replySource?{inReplyToSourceKey:replySource.sourceKey}:{})} : {})
    };
    room.messages.push(entry); this.prune(room);
    return structuredClone(entry);
  }
  snapshot(sessionId, {focusId} = {}) {
    const room = this.room(sessionId); this.prune(room);
    const focus = room.messages.findIndex(event => event.id === focusId || event.sourceKey === focusId);
    const order = [...room.messages.keys()].reverse();
    if (focus >= 0) order.splice(order.indexOf(focus), 1), order.unshift(focus);
    const selected = new Map(); let left = this.maxChars, clipped = false;
    for (const index of order) {
      if (left <= 0) { clipped = true; break; }
      const event = structuredClone(room.messages[index]);
      const fullText = event.text; event.text = fullText.slice(0, left); left -= event.text.length;
      event.textTruncated ||= event.text.length < fullText.length;
      if (event.quote?.text) {
        const original = event.quote.text; event.quote.text = original.slice(0, left); left -= event.quote.text.length;
        event.quote.truncated ||= event.quote.text.length < original.length;
      }
      clipped ||= event.textTruncated || event.quote?.truncated === true;
      selected.set(index, event);
    }
    const messages = [...selected].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
    const omitted = room.dropped + room.messages.length - messages.length;
    return {sessionId, generation: room.generation, messages, truncated: clipped || omitted > 0,
      range: {startedAt: room.startedAt, fromReceivedAt: messages[0]?.receivedAt ?? null,
        toReceivedAt: messages.at(-1)?.receivedAt ?? null, omitted, reason: room.reason,
        timeSource: messages.some(event => event.observationMode === 'baseline') ? 'observed' : 'received', historyComplete: false, chars: this.maxChars - left}};
  }
}
