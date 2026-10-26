"""Keep message observation IDs stable across Qt viewport widget recycling.

This is an in-memory receiver buffer, not a history/database reader. A missing
overlap is only bridged by the bound window's verified unread-count jump. The
bounded receiver buffer retains observations already seen in this process.
"""
import re
import uuid


def fingerprint(row):
    return (row.get('klass'), row.get('text', ''))


def voice_update(old, new):
    if old.get('klass') != new.get('klass') or old.get('klass') == 'mmui::ChatTextItemView':
        return False
    a = re.match(r'^语音(\d{1,3})["″”]?秒', old.get('text', ''))
    b = re.match(r'^语音(\d{1,3})["″”]?秒', new.get('text', ''))
    pending = old.get('text', '')[a.end():].strip() if a else None
    return bool(a and b and a.group(1) == b.group(1) and pending in ('', '未播放', '已播放', '未读', '已读', '转文字中', '正在转文字', '转换中'))


class NativeMessageTracker:
    def __init__(self):
        self.rooms = {}
        self.prefix = uuid.uuid4().hex
        self.serial = 0

    def new_id(self):
        self.serial += 1
        return f'xiaoxi_native_{self.prefix}_{self.serial}'

    def observe(self, name, generation, rows, unread_count=0):
        previous = self.rooms.get(name)
        old = previous['rows'] if previous and previous['generation'] == generation else []
        rows = [dict(row, nativeId=row['id']) for row in rows]
        old_by_native = {row['nativeId']: row for row in old}
        old_fp = [fingerprint(row) for row in old]
        new_fp = [fingerprint(row) for row in rows]
        verified_count = unread_count if old and type(unread_count) is int and 0 < unread_count <= 10000 else 0
        history_end = max(0, len(rows) - verified_count) if verified_count else len(rows)
        mapped = {}
        # A real native-ID overlap wins. Changed voice labels keep their ID so
        # the existing delayed-transcript queue can detect the same bubble.
        for j, row in enumerate(rows):
            if j >= history_end:
                continue
            prior = old_by_native.get(row['nativeId'])
            if prior and (fingerprint(prior) == fingerprint(row) or voice_update(prior, row)):
                mapped[j] = prior['id']
        # Conversion can replace the voice widget as well. A unique unchanged
        # neighbor and equal-duration pending slot provide local continuity;
        # an ambiguous run of voice bubbles does not permit reassociation.
        for j, row in enumerate(rows[:history_end]):
            if j in mapped:
                continue
            candidates = []
            for i, prior in enumerate(old):
                if not voice_update(prior, row):
                    continue
                left = i > 0 and j > 0 and old_fp[i-1] == new_fp[j-1] and old_fp.count(old_fp[i-1]) == new_fp.count(new_fp[j-1]) == 1
                right = i+1 < len(old) and j+1 < len(rows) and old_fp[i+1] == new_fp[j+1] and old_fp.count(old_fp[i+1]) == new_fp.count(new_fp[j+1]) == 1
                if left or right:
                    candidates.append(prior['id'])
            if len(candidates) == 1:
                mapped[j] = candidates[0]
        # Qt destroys/recreates the visible widgets when jumping to new mail.
        # Reattach the longest uniquely matching suffix, never a guessed author.
        anchor = None
        if old:
            anchor = next((j for j in mapped if mapped[j] == old[-1]['id']), None)
            if anchor is None:
                candidates = []
                for j, item in enumerate(new_fp):
                    if j >= history_end:
                        continue
                    if item != old_fp[-1]:
                        continue
                    size = 1
                    while size < min(len(old), j + 1) and old_fp[-size - 1] == new_fp[j - size]:
                        size += 1
                    candidates.append((size, j))
                if candidates:
                    best = max(size for size, _ in candidates)
                    winners = [j for size, j in candidates if size == best]
                    if len(winners) == 1 and (best > 1 or old_fp.count(old_fp[-1]) == 1 and new_fp.count(old_fp[-1]) == 1):
                        anchor = winners[0]
                        for offset in range(best):
                            mapped[anchor - offset] = old[-1 - offset]['id']
        for j, row in enumerate(rows):
            row['id'] = mapped.get(j) or self.new_id()
        delivery = rows
        mode = 'baseline' if not old else 'overlap' if anchor is not None else 'gap'
        fresh_count = 0
        # A count is supplied only after the exact group's real unread button
        # was consumed and latest viewport verified. Startup has no old anchor.
        if old and anchor is None and verified_count and rows:
            fresh_count = min(unread_count, len(rows), 99)
            fresh = rows[-fresh_count:]
            # The counter proves these are newly arrived even if a repeated
            # phrase or recycled RuntimeId resembles an older bubble.
            for row in fresh:
                row['id'] = self.new_id()
            mode = 'verified_unread_tail'
        # Native send verification also performs reads. Keep the observed stream
        # across those internal reads so a jump cannot consume the only anchor
        # before the JS polling loop sees it. No disk history is consulted.
        if old and mode in ('overlap', 'verified_unread_tail'):
            stream = [dict(row) for row in previous.get('stream', old)]
            latest_by_id = {row['id']:row for row in rows}
            stream = [latest_by_id.get(row['id'],row) for row in stream]
            fresh = rows[anchor + 1:] if mode == 'overlap' else fresh
            known = {row['id'] for row in stream}
            stream.extend(row for row in fresh if row['id'] not in known)
            delivery = stream[-100:]
        self.rooms[name] = {'generation': generation, 'rows': rows, 'stream': delivery}
        return delivery, {'mode': mode, 'visibleRows': len(rows), 'deliveredRows': len(delivery),
                          'unreadCount': unread_count, 'visibleUnreadRows': fresh_count,
                          'unreadOutsideViewport': max(0, unread_count - len(rows)) if mode == 'verified_unread_tail' else 0}
