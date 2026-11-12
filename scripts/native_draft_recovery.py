"""Owner-initiated recovery of a specific draft. This operation never sends."""
import hashlib


def clear_verified_draft(request, inspect, verify_identity, mark_attempt=lambda: None):
    text = request.get('text')
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError('缺少待核对的草稿')
    def checked():
        rows, field = inspect()
        hits = [index for index, row in enumerate(rows) if row[0] == request['anchorId']]
        if len(hits) != 1:
            raise RuntimeError('无法唯一找到原来信，保留隔离')
        index = hits[0]
        _, kind, label = rows[index]
        if kind != request['anchorClass'] or hashlib.sha256(label.encode('utf-8')).hexdigest() != request['anchorHash']:
            raise RuntimeError('原来信已变化，保留隔离')
        if any(kind == 'mmui::ChatTextItemView' and label == text for _, kind, label in rows[index + 1:]):
            raise RuntimeError('群中已出现相同文字，保留草稿和隔离')
        return field
    field = checked()
    if field.Value != text:
        raise RuntimeError('输入框已变化，保留现有草稿')
    verify_identity()
    field = checked()
    verify_identity()
    if field.Value != text:
        raise RuntimeError('清理前草稿变化，已停止')
    mark_attempt()
    field.SetValue('', waitTime=.1)
    field = checked()
    if field.Value != '':
        raise RuntimeError('未确认草稿清空，保留隔离')
    return {'cleared': True}
