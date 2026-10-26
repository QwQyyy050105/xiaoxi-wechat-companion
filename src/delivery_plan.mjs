export const REPLY_PART_SEPARATOR = '\n<xiaoxi-next-message/>\n';
export const STAY_SILENT_MARKER = '<xiaoxi-stay-silent/>';

function planError(message, code = 'reply_too_long') { const error = new Error(message); error.code = code; return error; }

// Markers have meaning only as standalone lines outside a code fence. The caller
// must pass the generated answer, never raw incoming text as a delivery command.
function markedParts(text) {
  const parts = [[]]; let fence = null;
  for (const line of text.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
    }
    if (!fence && line.trim() === '<xiaoxi-next-message/>') parts.push([]);
    else parts.at(-1).push(line);
  }
  return parts.map(lines => lines.join('\n').trim()).filter(Boolean);
}

function naturalSplit(text, maxLength) {
  const minimum = text.length - maxLength;
  const boundaries = [];
  const pattern = /\n\s*\n|[。！？；](?:[”」』])?\s*|[.!?;](?:["'])?\s+/g;
  let match;
  while ((match = pattern.exec(text))) {
    const end = match.index + match[0].length;
    if (end < minimum || end > maxLength) continue;
    // A split inside a fenced code block changes its meaning and rendering.
    const prefix = text.slice(0, end);
    let fence = null;
    for (const line of prefix.split('\n')) {
      const token = line.match(/^\s*(`{3,}|~{3,})/);
      if (token) { if (!fence) fence = token[1][0]; else if (fence === token[1][0]) fence = null; }
    }
    if (!fence) boundaries.push(end);
  }
  const at = boundaries.at(-1);
  if (!at) throw planError('回复过长且没有合适的自然分段位置，请缩小问题范围或要求简短回答');
  return [text.slice(0, at).trim(), text.slice(at).trim()];
}

export function planTextReply(text, {splitReplies = false, maxParts = 2, maxLength = 4000} = {}) {
  if (typeof text !== 'string' || !text.trim()) throw planError('模型未返回可发送正文', 'empty_reply');
  if (!Number.isInteger(maxParts) || maxParts < 1 || maxParts > 2 || !Number.isInteger(maxLength) || maxLength < 1 || maxLength > 4000) throw planError('文字发送计划上限无效', 'invalid_delivery_limits');
  const content = text.replace(/\r\n/g, '\n').trim();
  let chunks = markedParts(content);
  if (!chunks.length) throw planError('模型未返回可发送正文', 'empty_reply');
  if (!splitReplies) chunks = [chunks.join('\n\n')];
  if (chunks.length > maxParts) throw planError('回复超过两条气泡上限', 'too_many_reply_parts');
  if (chunks.length === 1 && chunks[0].length > maxLength) {
    if (!splitReplies || maxParts < 2 || chunks[0].length > maxLength * 2) throw planError('回复超过发送长度限制，请要求简短回答');
    chunks = naturalSplit(chunks[0], maxLength);
  }
  if (chunks.some(item => item.length > maxLength)) throw planError('分段后仍超过单条发送长度限制，请要求简短回答');
  return {parts: chunks.map((value, index) => ({text: value, index})), split: chunks.length > 1};
}
