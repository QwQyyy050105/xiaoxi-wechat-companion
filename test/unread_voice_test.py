"""Read delayed WeChat transcripts under a persistent unread banner."""
import pathlib
import tempfile
import unittest

from native_read_efficiency_test import Control, ROOT, d, fixture, read_once


def voice(number=80, label='语音3"秒未播放'):
    return Control('voice.chat_bubble_item_view', text=label, number=number,
                   klass='mmui::ChatVoiceItemView')


class UnreadVoiceTests(unittest.TestCase):
    def setUp(self):
        (ROOT / 'temp').mkdir(exist_ok=True)
        folder = tempfile.TemporaryDirectory(prefix='unread_voice_', dir=ROOT / 'temp')
        self.addCleanup(folder.cleanup)
        self.folder = pathlib.Path(folder.name)
        self.bridge, self.name, _, self.messages, _, self.bubbles = fixture(3)
        self.banner = Control('new_notice', text='2条新消息', role='ButtonControl', number=90)
        self.banner.IsEnabled = True
        self.spoken = voice()

    def read(self):
        return read_once(self.bridge, self.name, self.folder)

    def receive_pending(self):
        self.read()
        self.messages.children.extend([self.spoken, self.banner])
        result = self.read()
        self.assertTrue(result['continuity']['unreadBeyondViewport'])
        return result['messages'][-1]['id']

    def test_visible_pending_then_transcript_is_same_message_and_does_not_repeat(self):
        original_id = self.receive_pending()
        self.spoken.Name = '语音3"秒正在转文字'
        self.assertEqual(self.read()['messages'][-1]['id'], original_id)
        self.spoken.Name = '语音3"秒小汐，今天吃什么'
        result = self.read()
        self.assertTrue(result['continuity']['unreadBeyondViewport'])
        found = [r for r in result['messages'] if r['id'] == original_id]
        self.assertEqual([r['text'] for r in found], [self.spoken.Name])
        with self.assertRaises(d.ViewportPending):
            self.read()

    def test_conversion_and_new_text_can_arrive_in_the_same_scrolled_viewport(self):
        original_id = self.receive_pending()
        self.spoken.Name = '语音3"秒小汐，等下见'
        next_text = Control('new.chat_bubble_item_view', text='新的消息', number=81,
                            klass='mmui::ChatTextItemView')
        self.messages.children = [*self.bubbles[1:], self.spoken, next_text, self.banner]
        rows = self.read()['messages']
        self.assertEqual(rows[-2]['id'], original_id)
        self.assertEqual(rows[-2]['text'], self.spoken.Name)
        self.assertEqual(rows[-1]['text'], next_text.Name)

    def test_historical_voice_is_never_used_as_live_evidence(self):
        self.messages.children.append(self.spoken)
        self.read()
        self.messages.children.append(self.banner)
        self.spoken.Name = '语音3"秒旧消息'
        with self.assertRaises(d.ViewportPending):
            self.read()

    def test_another_changed_row_or_recycled_id_cannot_authorize_the_view(self):
        self.receive_pending()
        self.spoken.Name = '语音3"秒转写'
        self.bubbles[1].Name = '内容已变化'
        with self.assertRaises(d.ViewportPending):
            self.read()
        self.bubbles[1].Name = 'message 1'
        self.spoken.number = 82
        with self.assertRaises(d.ViewportPending):
            self.read()

    def test_duration_identity_window_and_scope_are_checked(self):
        self.receive_pending()
        for wrong_label in ('语音4"秒别的消息', '普通文字'):
            with self.subTest(wrong_label=wrong_label):
                self.spoken.Name = wrong_label
                with self.assertRaises(d.ViewportPending):
                    self.read()
        self.spoken.Name = '语音3"秒可识别'
        self.bridge.created += 1
        with self.assertRaises(d.ViewportPending):
            self.read()
        self.bridge.created -= 1
        self.bridge.voice_targets = frozenset()
        with self.assertRaises(d.ViewportPending):
            self.read()

    def test_duplicate_runtime_id_and_missing_stable_anchor_are_rejected(self):
        self.receive_pending()
        self.spoken.Name = '语音3"秒可识别'
        self.messages.children = [*self.bubbles, self.spoken, self.spoken, self.banner]
        with self.assertRaises(d.ViewportPending):
            self.read()
        self.messages.children = [self.spoken, self.banner]
        with self.assertRaises(d.ViewportPending):
            self.read()

    def test_an_already_transcribed_voice_cannot_authorize_later_edits(self):
        self.spoken.Name = '语音3"秒原始转写'
        self.receive_pending()
        self.spoken.Name = '语音3"秒后来替换的文本'
        with self.assertRaises(d.ViewportPending):
            self.read()
