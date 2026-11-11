"""Exercise real receiver traversal with synthetic controls; never access WeChat."""
import json
import pathlib
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from contextlib import contextmanager
from contextlib import nullcontext
from unittest.mock import Mock, call, patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'test'))
from native_test_bootstrap import configure_test_environment
configure_test_environment()
sys.path.insert(0, str(ROOT / 'scripts'))
import desktop_bridge as d


class Control:
    calls = 0

    def __init__(self, aid, children=(), text='', role='PaneControl', klass='QWidget', number=0):
        self.AutomationId = aid
        self.children = list(children)
        self.Name = text
        self.ControlTypeName = role
        self.ClassName = klass
        self.number = number
        self.IsEnabled = False
        self.BoundingRectangle = SimpleNamespace(left=0, top=0, right=900, bottom=600)
        self.HelpText = ''
        self.value = ''
        self.children_reads = 0

    def GetChildren(self):
        Control.calls += 1
        self.children_reads += 1
        return self.children

    def GetRuntimeId(self):
        return [42, self.number]

    def GetValuePattern(self):
        return SimpleNamespace(Value=self.value)

    def GetScrollPattern(self):
        return None

    def GetPropertyValue(self, _):
        return False


def fixture(count=100):
    target_id, name = next(iter(d.AUTHORIZED_GROUPS.items()))
    bubbles = []
    for i in range(count):
        children = [Control(f'detail_{i}_{j}', text='synthetic nested text') for j in range(8)]
        bubbles.append(Control(f'{i}.chat_bubble_item_view', children, f'message {i}',
                               klass='mmui::ChatTextItemView', number=i))
    messages = Control('chat_message_list', bubbles, role='ListControl')
    field = Control('chat_input_field', [Control('editor_child')], role='EditControl')
    root = Control('ChatSingleWindowSynthetic', [messages, field], klass='mmui::ChatSingleWindow')
    bridge = object.__new__(d.Bridge)
    bridge.pid = 20
    bridge.created = 100
    bridge.check = lambda *args: None
    bridge.targets = [dict(id=target_id, name=name, kind='group')]
    def room(_, *, chrome_out=None):
        if chrome_out is not None:chrome_out.extend(d.walk_chrome(root))
        return root, 7
    bridge.room = room
    return bridge, name, root, messages, field, bubbles


def read_once(bridge, name, folder, **kwargs):
    (folder / 'data').mkdir(exist_ok=True)
    with patch.object(d, 'ROOT', folder), patch.object(d, 'focus_state', return_value={'foregroundPid': 99}), \
         patch.object(d, 'modifiers_down', return_value=False), patch.object(d, 'U', SimpleNamespace(
             IsIconic=lambda _: True, IsWindowVisible=lambda _: True, GetAncestor=lambda *_: 7)):
        return bridge.read(name, **kwargs)


class NativeReadEfficiencyTests(unittest.TestCase):
    def setUp(self):
        (ROOT / 'temp').mkdir(exist_ok=True)
        self.folder = tempfile.TemporaryDirectory(prefix='native_read_', dir=ROOT / 'temp')
        self.addCleanup(self.folder.cleanup)
        self.path = pathlib.Path(self.folder.name)

    def test_receiver_preserves_last_100_rows_order_ids_and_media_updates(self):
        bridge, name, root, messages, field, bubbles = fixture(120)
        first = read_once(bridge, name, self.path)
        self.assertEqual([r['text'] for r in first['messages']], [f'message {i}' for i in range(20, 120)])
        voice = bubbles[-1]
        voice.ClassName = 'mmui::ChatVoiceItemView'
        voice.Name = '语音3"秒未播放'
        before = read_once(bridge, name, self.path)
        voice.Name = '语音3"秒测试语音转写'
        after = read_once(bridge, name, self.path)
        self.assertEqual(before['messages'][-1]['id'], after['messages'][-1]['id'])
        self.assertEqual(after['messages'][-1]['text'], voice.Name)
        self.assertEqual(after['continuity']['mode'], 'overlap')
        self.assertFalse(after['draft'])
        field.value = 'manual draft'
        self.assertTrue(read_once(bridge, name, self.path)['draft'])

    def test_normal_read_skips_bubble_details_and_does_not_cache_next_read(self):
        bridge, name, root, messages, field, bubbles = fixture()
        read_once(bridge, name, self.path)
        self.assertTrue(all(b.children_reads == 0 for b in bubbles))
        self.assertEqual(field.children_reads, 0)
        bubbles[-1].Name = 'updated message'
        next_read = read_once(bridge, name, self.path)
        self.assertEqual(next_read['messages'][-1]['text'], 'updated message')
        self.assertTrue(all(b.children_reads == 0 for b in bubbles))

    def test_duplicate_message_list_or_editor_fails_before_message_content(self):
        for aid in ('chat_message_list', 'chat_input_field'):
            bridge, name, root, messages, field, bubbles = fixture()
            root.children.append(Control(aid))
            with self.assertRaisesRegex(RuntimeError, '不唯一'):
                read_once(bridge, name, self.path)
            self.assertEqual(sum(b.children_reads for b in bubbles), 0)

    def test_diagnostic_request_still_expands_bubble_details(self):
        bridge, name, root, messages, field, bubbles = fixture(2)
        result = read_once(bridge, name, self.path, diagnostic=True)
        self.assertEqual(len(result['messages'][0]['children']), 9)
        self.assertTrue(all(b.children_reads == 1 for b in bubbles))

    def test_notice_scan_keeps_list_overlays_but_ignores_message_and_draft_buttons(self):
        bridge, name, root, messages, field, bubbles = fixture(2)
        genuine = Control('overlay', text='2条新消息', role='ButtonControl')
        spoof = Control('spoof', text='100条新消息', role='ButtonControl')
        bubbles[0].children.append(spoof)
        field.children.append(Control('draft_spoof', text='someone提到了你', role='ButtonControl'))
        messages.children.append(genuine)
        found = [c.Name for c in d.walk_notices(root) if c.ControlTypeName == 'ButtonControl']
        self.assertEqual(found, ['2条新消息'])
        self.assertTrue(all(b.children_reads == 0 for b in bubbles))
        self.assertEqual(field.children_reads, 0)

    def test_row_enumeration_handles_containers_without_promoting_embedded_quotes(self):
        bridge, name, root, messages, field, bubbles = fixture(2)
        quoted = Control('quoted.chat_bubble_item_view', text='embedded quotation', number=90)
        bubbles[0].children.append(quoted)
        messages.children = [Control('row_container', bubbles), Control('chat_input_field', [quoted])]
        rows = read_once(bridge, name, self.path)['messages']
        self.assertEqual([row['text'] for row in rows], ['message 0', 'message 1'])
        self.assertEqual(quoted.children_reads, 0)
        with self.assertRaisesRegex(RuntimeError, '数量异常'):
            list(d.message_bubbles(messages, limit=2))

    def test_unread_notice_stops_before_tracker_observe_until_owner_jumps(self):
        bridge, name, root, messages, field, bubbles = fixture(2)
        first=read_once(bridge, name, self.path)
        notice = Control('new_notice', text='1条新消息', role='ButtonControl', number=50)
        notice.IsEnabled = True
        messages.children.append(notice)
        new_message = Control('fresh.chat_bubble_item_view', text='new synthetic question', number=90,
                              klass='mmui::ChatTextItemView')
        with patch.object(d.U,'PostMessageW',side_effect=AssertionError('no unread click')):
            with self.assertRaisesRegex(RuntimeError,'手动点未读提示跳到最新'):
                read_once(bridge,name,self.path)
        self.assertEqual(bridge.message_tracker.rooms[name]['rows'][-1]['text'],first['messages'][-1]['text'])
        # A human jump changes the viewport; only then may normal ingestion see it.
        messages.children=[*bubbles,new_message]
        result=read_once(bridge,name,self.path)
        self.assertEqual(result['messages'][-1]['text'],'new synthetic question')
        self.assertEqual(bridge.message_tracker.rooms[name]['rows'][-1]['text'],'new synthetic question')

    def test_unread_jump_reacquires_changed_view_before_returning_messages(self):
        bridge, name, root, messages, field, bubbles = fixture(1)
        read_once(bridge, name, self.path)
        other, _, replacement, *_ = fixture(2)
        def changed_view(*args):
            bridge.room = other.room
            return {'advanced': True, 'unreadCount': 1}
        bridge.refresh_unread = changed_view
        received = read_once(bridge, name, self.path)
        self.assertEqual(received['messages'][-1]['text'], 'message 1')
        self.assertEqual(received['continuity']['visibleRows'], 2)

    def test_new_content_requires_fresh_account_verification_before_delivery(self):
        bridge, name, root, messages, field, bubbles = fixture(2)
        checks = []
        bridge.check = lambda *args: checks.append(args)
        first = read_once(bridge, name, self.path)
        self.assertEqual(checks, [(True,)])
        read_once(bridge, name, self.path)
        self.assertEqual(checks, [(True,)])
        bubbles[-1].Name = 'changed payload'
        def denied(*args):raise RuntimeError('account mismatch')
        bridge.check = denied
        with self.assertRaisesRegex(RuntimeError, 'account mismatch'):
            read_once(bridge, name, self.path)
        self.assertEqual(bridge.message_tracker.rooms[name]['rows'][-1]['text'], first['messages'][-1]['text'])
        bridge.check = lambda *args: checks.append(args)
        delivered = read_once(bridge, name, self.path)
        self.assertEqual(checks, [(True,), (True,)])
        self.assertEqual(delivered['messages'][-1]['text'], 'changed payload')

    def test_structural_scan_remains_bounded(self):
        root = Control('root', [Control(f'node_{i}') for i in range(6)])
        with self.assertRaisesRegex(RuntimeError, '数量异常'):
            list(d.walk_notices(root, limit=3))



class SendChromeTests(unittest.TestCase):
    def setUp(self):
        self.bridge, self.name, self.root, self.messages, self.field, _ = fixture(100)
        del self.bridge.room  # exercise the production room() binding and snapshot
        self.root.NativeWindowHandle = 7
        self.title = Control('header.current_chat_name_label', text=self.name)
        self.group = Control('header', [self.title], klass='mmui::ChatTitleBarChatRoomView')
        self.button = Control('submit', text='发送', role='ButtonControl')
        self.button.IsEnabled = True
        self.root.children.extend([self.group, self.button])
        self.pattern = SimpleNamespace(Value='')
        self.pattern.SetValue = lambda text, **_: setattr(self.pattern, 'Value', text)
        self.field.GetValuePattern = lambda: self.pattern
        self.bridge.check = Mock()
        self.bridge.focus_lease = lambda *_: nullcontext(SimpleNamespace(poll=lambda: None))
        self.window = dict(pid=self.bridge.pid, title=self.name, hwnd=7)
        self.start_patch(d, 'desktop_ready')
        self.start_patch(d, 'windows', return_value=[self.window])
        self.start_patch(d.auto, 'ControlFromHandle', return_value=self.root)
        self.start_patch(d.U, 'GetForegroundWindow', return_value=99)
        self.start_patch(d, 'focus_state', return_value={'foregroundPid': 999})
        self.start_patch(d, 'modifiers_down', return_value=False)
        self.post = self.start_patch(d.U, 'PostMessageW', return_value=True)

    def start_patch(self, target, attr, **options):
        patcher = patch.object(target, attr, **options)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def stub_snapshot_and_echo(self):
        self.bridge.read = Mock(side_effect=[
            {'hwnd': 7, 'messages': [], 'draft': False},
            {'hwnd': 7, 'messages': [{'id': 'new', 'text': 'reply'}], 'draft': False},
        ])

    def test_real_room_supplies_readable_chrome_only_after_group_binding(self):
        chrome = []
        root, hwnd = self.bridge.room(self.name, chrome_out=chrome)
        self.assertIs(root, self.root)
        self.assertEqual(hwnd, 7)
        self.assertIn(self.field, chrome)
        self.assertIn(self.messages, chrome)
        self.assertIn(self.button, chrome)
        self.assertEqual(self.messages.children_reads, 0)
        self.assertTrue(all(item not in chrome for item in self.messages.children))

    def test_invalid_group_title_does_not_export_editor_or_list(self):
        self.title.Name = 'other room'
        chrome = []
        with self.assertRaisesRegex(RuntimeError, '群标题不匹配'):
            self.bridge.room(self.name, chrome_out=chrome)
        self.assertEqual(chrome, [])

    def test_prepare_and_commit_each_walk_the_bound_chrome_once(self):
        self.stub_snapshot_and_echo()
        self.messages.children[0].children.append(Control('fake-submit', text='发送', role='ButtonControl'))
        result = self.bridge._send(self.name, 'reply')
        self.assertEqual(result['status'], 'local_echo', result)
        self.assertEqual(self.bridge.check.call_args_list.count(call(True)), 2)
        self.assertEqual(self.root.children_reads, 2)
        self.assertEqual(self.messages.children_reads, 0)
        self.assertEqual(self.field.children_reads, 0)
        self.assertEqual([c.args[:3] for c in self.post.call_args_list],
                         [(7, 0x0100, 13), (7, 0x0101, 13)])

    def test_duplicate_visible_controls_fail_before_return(self):
        self.root.children.append(Control('also-submit', text='发送', role='ButtonControl'))
        self.stub_snapshot_and_echo()
        result = self.bridge._send(self.name, 'reply')
        self.assertEqual(result['status'], 'not_sent')
        self.assertIn('发送按钮不唯一', result['note'])
        self.assertEqual(self.pattern.Value, '')
        self.post.assert_not_called()

    def test_replaced_editor_is_read_again_at_commit(self):
        self.stub_snapshot_and_echo()
        def replace_editor(text, **_):
            self.pattern.Value = text
            new_editor = Control('chat_input_field', role='EditControl')
            new_editor.value = 'owner typed into replacement'
            self.root.children[self.root.children.index(self.field)] = new_editor
            self.pattern.SetValue = lambda value, **_: setattr(self.pattern, 'Value', value)
        self.pattern.SetValue = replace_editor
        result = self.bridge._send(self.name, 'reply')
        self.assertEqual(result['status'], 'not_sent')
        self.assertIn('草稿变化', result['note'])
        self.assertEqual(self.root.children[1].value, 'owner typed into replacement')
        self.post.assert_not_called()

    def test_replaced_hwnd_is_not_sent_to(self):
        self.stub_snapshot_and_echo()
        def edit(text, **_):
            self.pattern.Value = text
            self.window['hwnd'] = 8
        self.pattern.SetValue = edit
        result = self.bridge._send(self.name, 'reply')
        self.assertEqual(result['status'], 'not_sent')
        self.assertIn('窗口已更换', result['note'])
        self.post.assert_not_called()


def benchmark():
    (ROOT / 'temp').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='native_bench_', dir=ROOT / 'temp') as folder:
        bridge, name, *_ = fixture()
        Control.calls = 0
        started = time.perf_counter()
        result = read_once(bridge, name, pathlib.Path(folder))
        print(json.dumps({'syntheticOnly': True, 'realWechatReads': 0, 'cloudCalls': 0,
                          'rows': len(result['messages']), 'getChildrenCalls': Control.calls,
                          'elapsedMs': round((time.perf_counter() - started) * 1000, 3)}))


if __name__ == '__main__':
    if sys.argv[1:] == ['--benchmark']:
        benchmark()
    else:
        unittest.main()
