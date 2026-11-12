import {createHash} from 'node:crypto';
import {normalizeNativeMedia} from './native_media.mjs';

// A reply may be checked against its incoming message after a receiver restart.
// The Windows process and group window must still be the ones that received it.
export function recoveryOutbox(state, target, sessionId, expectedId) {
  const rows = state.outbox.filter(row => row.sessionId === sessionId);
  const last = rows.at(-1);
  if (!target?.quarantined || !expectedId || last?.id !== expectedId || last.status !== 'unknown' || last.draftClearedAt)
    throw Error('待核对的最后一条发送记录已变化');
  const checkpoint = rows.findLastIndex(row => row.status === 'local_echo' || row.ownerReviewedAt || row.draftClearedAt);
  if (rows.slice(checkpoint + 1).filter(row => row.status === 'unknown').length !== 1)
    throw Error('本群有多条未确认发送，请在微信逐条核对');
  if (typeof last.text !== 'string' || !last.text.trim() || [...last.text].length > 4000)
    throw Error('这条发送记录没有可核对的草稿');
  return last;
}

export function recoveryRequest(state, target, out, snapshot, expectedDraft = true) {
  const binding = target.windowBinding ?? target.peerId;
  if (!binding || (snapshot.windowBinding ?? snapshot.peerId) !== binding || snapshot.group !== target.name ||
      !Number.isInteger(snapshot.hwnd) || !Number.isInteger(snapshot.pid) || !(snapshot.created > 0))
    throw Error('当前账号或会话窗口无法核对');
  if (snapshot.draft !== expectedDraft || snapshot.continuity?.unreadBeyondViewport || snapshot.continuity?.unreadOutsideViewport)
    throw Error('草稿为空，或群里有未查看的新消息');
  const requestId = out.requestIds?.at(-1);
  const input = state.inbox.find(row => row.id === requestId && row.sessionId === out.sessionId);
  const prefix = `${snapshot.created}/${snapshot.hwnd}/${target.id}/`;
  if (!input?.event?.id || !input.key?.startsWith(prefix + input.event.id + '/') || typeof input.event.text !== 'string' || !input.event.text)
    throw Error('缺少本次来信的窗口或消息记录，请手动核对');
  const rest = input.key.slice((prefix + input.event.id + '/').length);
  const klass = rest.split('/', 1)[0];
  const candidates = snapshot.messages.map((row, index) => ({row, item: normalizeNativeMedia(row), index})).filter(({row, item}) =>
    row.klass === klass && item.text === input.event.text &&
    (klass === 'mmui::ChatTextItemView' || (item.inputModality?.kind === 'platform_transcript' &&
      item.inputModality.durationSeconds === input.event.inputModality?.durationSeconds)));
  const exact = candidates.filter(({row}) => row.id === input.event.id);
  const [anchor] = exact.length === 1 ? exact : (candidates.length === 1 ? candidates : []);
  if (!anchor?.row.nativeId) throw Error('原来信已移出窗口或存在同文来信，请手动核对');
  if (snapshot.messages.slice(anchor.index + 1).some(row => row.klass === 'mmui::ChatTextItemView' && row.text === out.text))
    throw Error('原来信之后已出现相同文字，保留草稿和隔离');
  return {group:target.name, targetId:target.id, binding, hwnd:snapshot.hwnd, pid:snapshot.pid,
    created:snapshot.created, anchorId:anchor.row.nativeId, anchorClass:klass,
    anchorHash:createHash('sha256').update(anchor.row.text, 'utf8').digest('hex'), text:out.text};
}
