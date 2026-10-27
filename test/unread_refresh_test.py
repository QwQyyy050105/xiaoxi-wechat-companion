# Install the committed fictional registry before importing production adapters.
import pathlib as _test_pathlib
import sys as _test_sys
_test_sys.path.insert(0, str(_test_pathlib.Path(__file__).resolve().parent))
from native_test_bootstrap import configure_test_environment
configure_test_environment()

import pathlib,sys,tempfile,unittest
from contextlib import contextmanager
from unittest.mock import Mock,patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import desktop_bridge as bridge

class UnreadRefreshTests(unittest.TestCase):
    def setup_bridge(self):
        b=object.__new__(bridge.Bridge);b.pid=20
        b.targets=[{'id':'group_abao','name':'Example Group A','kind':'group'}]
        b.check=Mock();b.room=Mock(return_value=('root',100))
        guard=Mock();guard.poll.return_value=None
        @contextmanager
        def lease(*args):yield guard
        b.focus_lease=lease
        return b

    def test_background_jump_targets_only_verified_button_and_finishes_mention_then_new_messages(self):
        b=self.setup_bridge();button=Mock();button.ControlTypeName='ButtonControl';button.IsEnabled=True;button.GetPropertyValue.return_value=True;button.GetRuntimeId.return_value=[1]
        labels=['某人提到了你','3条新消息',None];calls=[]
        def walk(_):
            if labels[0] is None:return []
            button.Name=labels[0];return [button]
        def post(hwnd,control,root):
            self.assertEqual(hwnd,100);self.assertIs(control,button);calls.append(labels.pop(0))
        state={'foreground':55,'foregroundPid':77,'lastInputTick':4}
        with tempfile.TemporaryDirectory(dir=bridge.ROOT/'temp',prefix='unread_test_') as temp:
            root=pathlib.Path(temp);(root/'data').mkdir()
            with patch.object(bridge,'ROOT',root),patch.object(bridge,'walk_notices',side_effect=walk),patch.object(bridge,'post_unread_button',side_effect=post),patch.object(bridge,'focus_state',return_value=state),patch.object(bridge,'modifiers_down',return_value=False),patch.object(bridge.U,'IsIconic',return_value=True),patch.object(bridge.time,'sleep'):
                self.assertTrue(b.refresh_unread('Example Group A','root',100))
                self.assertEqual(calls,['某人提到了你','3条新消息'])
                self.assertFalse(b.refresh_unread('Example Group A','root',100))

    def test_foreground_wechat_never_moves_users_view(self):
        b=self.setup_bridge()
        with patch.object(bridge,'focus_state',return_value={'foreground':100,'foregroundPid':20}),patch.object(bridge,'walk_notices',side_effect=AssertionError('must not inspect or invoke controls')):
            self.assertFalse(b.refresh_unread('Example Group A','root',100))

    def test_nested_send_lease_never_jumps_or_opens_another_lease(self):
        b=self.setup_bridge();b.focus_depth=1
        with patch.object(bridge,'focus_state',side_effect=AssertionError('nested refresh')):
            self.assertFalse(b.refresh_unread('Example Group A','root',100))

    def test_unapproved_group_is_rejected_before_reading_controls(self):
        b=self.setup_bridge()
        with patch.object(bridge,'walk_notices',side_effect=AssertionError('unapproved UI read')):
            with self.assertRaises(RuntimeError):b.refresh_unread('其他群','root',100)

    def test_non_invoke_button_does_not_fall_back_to_mouse_or_keys(self):
        b=self.setup_bridge();button=Mock();button.ControlTypeName='ButtonControl';button.Name='2条新消息';button.IsEnabled=True;button.GetPropertyValue.return_value=False
        with patch.object(bridge,'walk_notices',return_value=[button]),patch.object(bridge,'focus_state',return_value={'foreground':55,'foregroundPid':77}),patch.object(bridge,'modifiers_down',return_value=False):
            self.assertFalse(b.refresh_unread('Example Group A','root',100))
        button.GetInvokePattern.assert_not_called()

    def test_minimized_position_uses_actual_qt_client_origin(self):
        self.assertEqual(bridge.minimized_unread_point([831,240,1728,1200],[831,360,1728,987],[1473,360,1707,433],(919,971)),(759,156))

    def test_minimized_position_rejects_stale_layout_and_non_list_buttons(self):
        for bounds,size in [([1473,250,1707,300],(919,971)),([1473,360,1900,433],(919,971)),([1473,360,1707,433],(1200,971))]:
            with self.subTest(bounds=bounds,size=size),self.assertRaises(RuntimeError):
                bridge.minimized_unread_point([831,240,1728,1200],[831,360,1728,987],bounds,size)

    def test_successful_button_call_without_progress_is_an_error_not_healthy_listening(self):
        b=self.setup_bridge();button=Mock();button.ControlTypeName='ButtonControl';button.Name='3条新消息';button.IsEnabled=True;button.GetPropertyValue.return_value=True;button.GetRuntimeId.return_value=[1]
        with tempfile.TemporaryDirectory(dir=bridge.ROOT/'temp',prefix='unread_test_') as temp:
            root=pathlib.Path(temp);(root/'data').mkdir()
            with patch.object(bridge,'ROOT',root),patch.object(bridge,'walk_notices',return_value=[button]),patch.object(bridge,'post_unread_button',return_value='target_hwnd_button_messages') as post,patch.object(bridge,'focus_state',return_value={'foreground':55,'foregroundPid':77}),patch.object(bridge,'modifiers_down',return_value=False),patch.object(bridge.U,'IsIconic',return_value=True),patch.object(bridge.time,'sleep'):
                with self.assertRaisesRegex(RuntimeError,'仍停在旧消息'):b.refresh_unread('Example Group A','root',100)
                with self.assertRaisesRegex(RuntimeError,'仍停在旧消息'):b.refresh_unread('Example Group A','root',100)
                post.assert_called_once()

    def test_minimized_post_stays_on_exact_hwnd_without_restore_or_global_input(self):
        root=Mock();root.ClassName='mmui::ChatSingleWindow';root.NativeWindowHandle=100
        button=Mock();messages=Mock()
        def bounds(control):return [831,240,1728,1200] if control is root else [831,360,1728,987] if control is messages else [1473,360,1707,433]
        def placement(hwnd,pointer):
            value=pointer._obj.rcNormalPosition;value.left=820;value.top=240;value.right=1739;value.bottom=1211
            return True
        with patch.object(bridge,'rect',side_effect=bounds),patch.object(bridge,'unique_chrome',return_value=messages),patch.object(bridge.U,'IsIconic',return_value=True),patch.object(bridge.U,'GetWindowPlacement',side_effect=placement),patch.object(bridge.U,'PostMessageW',return_value=True) as post,patch.object(bridge.U,'ShowWindow',side_effect=AssertionError('must stay minimized')),patch.object(bridge.time,'sleep'):
            self.assertEqual(bridge.post_unread_button(100,button,root),'minimized_qt_client_messages')
            self.assertEqual([c.args for c in post.call_args_list],[(100,0x0201,1,759|(156<<16)),(100,0x0202,0,759|(156<<16))])

    def test_send_targets_verified_editor_button_instead_of_current_keyboard_focus(self):
        root,field,button=Mock(),Mock(),Mock()
        button.ControlTypeName='ButtonControl';button.Name='发送';button.IsEnabled=True
        def bounds(control):return [100,200,1000,1100] if control is root else [120,900,980,1020] if control is field else [910,1040,980,1080]
        with patch.object(bridge,'unique_chrome',return_value=field),patch.object(bridge,'rect',side_effect=bounds),patch.object(bridge,'post_verified_button') as post:
            bridge.post_send_button(100,button,root)
            post.assert_called_once_with(100,button,root,[100,900,1000,1100])
            button.Name='转发'
            with self.assertRaises(RuntimeError):bridge.post_send_button(100,button,root)
            self.assertEqual(post.call_count,1)

if __name__=='__main__':unittest.main()
