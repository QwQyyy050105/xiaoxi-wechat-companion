"""Exercise group-specific voice filtering through the native receiver on synthetic windows."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from native_read_efficiency_test import Control, ROOT, d, fixture, read_once
from native_voice_scope import voice_target_ids


class SealedVoice(Control):
    """Observing private UIA content fails the test, even if later discarded."""

    def __getattribute__(self, key):
        if key in ('Name', 'HelpText', 'GetPropertyValue', 'GetChildren'):
            raise AssertionError('voice content was accessed: ' + key)
        return super().__getattribute__(key)


class NativeVoiceScopeTests(unittest.TestCase):
    def setUp(self):
        (ROOT / 'temp').mkdir(exist_ok=True)
        folder = tempfile.TemporaryDirectory(prefix='native_voice_scope_', dir=ROOT / 'temp')
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        self.groups = list(d.AUTHORIZED_GROUPS.items())

    def receiver(self, options, group_index=0):
        target, name = self.groups[group_index]
        bridge, _, _, messages, _, _ = fixture(0)
        bridge.targets = [dict(id=target, name=name, kind='group')]
        bridge.voice_targets = voice_target_ids(options, (key for key, _ in self.groups))
        return bridge, name, messages

    @staticmethod
    def row(number, klass='mmui::ChatVoiceItemView', guarded=True, text='sample'):
        cls = SealedVoice if guarded else Control
        return cls(str(number) + '.chat_bubble_item_view', number=number, klass=klass, text=text)

    def test_scope_accepts_only_group_ids_without_duplicates(self):
        for invalid in (None, False, 'room', ['unknown'], [None], [[]], ['room', 'room']):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, 'native_voice_targets_invalid'):
                voice_target_ids({'voiceTargetIds': invalid}, ['room'])

    def test_legacy_scope_reads_delayed_transcript_for_each_authorized_group(self):
        for index in range(len(self.groups)):
            with self.subTest(index=index):
                bridge, name, messages = self.receiver({}, index)
                row = self.row(1, guarded=False, text='语音3"秒未播放')
                messages.children = [row]
                before = read_once(bridge, name, self.folder)['messages'][-1]
                row.Name = '语音3"秒synthetic transcript'
                after = read_once(bridge, name, self.folder)['messages'][-1]
                self.assertEqual(before['id'], after['id'])
                self.assertEqual(after['text'], row.Name)

    def test_explicit_empty_scope_hides_voice_in_every_room(self):
        for index in range(len(self.groups)):
            with self.subTest(index=index):
                bridge, name, messages = self.receiver({'voiceTargetIds': []}, index)
                messages.children = [self.row(1)]
                result = read_once(bridge, name, self.folder)['messages']
                self.assertEqual([row['text'] for row in result], [''])

    def test_only_selected_group_can_expose_voice_contents(self):
        selected = {'voiceTargetIds': [self.groups[1][0]]}
        for index in (0, 1):
            with self.subTest(index=index):
                bridge, name, messages = self.receiver(selected, index)
                messages.children = [self.row(1, guarded=index == 0, text='语音3"秒synthetic transcript')]
                row = read_once(bridge, name, self.folder, diagnostic=True)['messages'][0]
                self.assertEqual(row['text'], '' if index == 0 else '语音3"秒synthetic transcript')
                self.assertEqual('children' in row, index == 1)
                receipt = self.folder / 'data' / ('read_health_' + self.groups[index][0] + '.json')
                self.assertIs(json.loads(receipt.read_text(encoding='utf-8'))['voiceIntakeEnabled'], index == 1)

    def test_multiple_disabled_voice_rows_keep_distinct_stable_ids_and_following_text(self):
        bridge, name, messages = self.receiver({'voiceTargetIds': []})
        messages.children = [self.row(1), self.row(2)]
        first = read_once(bridge, name, self.folder)['messages']
        messages.children.append(self.row(3, 'mmui::ChatTextItemView', guarded=False, text='next message'))
        second = read_once(bridge, name, self.folder)['messages']
        self.assertNotEqual(first[0]['id'], first[1]['id'])
        self.assertEqual([row['id'] for row in first], [row['id'] for row in second[:2]])
        self.assertEqual([row['text'] for row in second], ['', '', 'next message'])

    def test_diagnostic_preserves_text_and_images_without_reading_nested_voice_or_unknown_row(self):
        bridge, name, messages = self.receiver({'voiceTargetIds': []})
        text = self.row(1, 'mmui::ChatTextItemView', guarded=False, text='a regular message')
        text.children.append(self.row(20))
        messages.children = [text, self.row(2, 'mmui::ChatImageItemView', False, '[图片]'),
                             self.row(3, 'mmui::ChatImageGroupItemView', False, '[图片]'),
                             self.row(4, 'mmui::ChatUnknownItemView')]
        rows = read_once(bridge, name, self.folder, diagnostic=True)['messages']
        self.assertEqual([r['text'] for r in rows], ['a regular message', '[图片]', '[图片]', ''])
        for row in rows:
            self.assertTrue(set(row).isdisjoint({'description', 'help', 'children'}))

    def test_owner_file_and_receiver_apply_the_same_scope(self):
        import owner_config
        config = dict(d.CONFIG)
        selected = [self.groups[1][0]]
        config['native'] = {'enabled': True, 'voiceTargetIds': selected}
        file = self.folder / 'deployment.local.json'
        file.write_text(json.dumps(config), encoding='utf-8')
        with patch.object(owner_config, 'CONFIG_PATH', file):
            with patch.object(d, 'CONFIG', owner_config.load_owner_config()):
                self.assertEqual(d.Bridge().voice_targets, set(selected))
            config['native']['voiceTargetIds'] = ['unknown']
            file.write_text(json.dumps(config), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'native_voice_targets_invalid'):
                owner_config.load_owner_config()
