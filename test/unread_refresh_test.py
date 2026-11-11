# Install the committed fictional registry before importing production adapters.
import pathlib as _test_pathlib
import sys as _test_sys
_test_sys.path.insert(0, str(_test_pathlib.Path(__file__).resolve().parent))
from native_test_bootstrap import configure_test_environment
configure_test_environment()

import pathlib,sys,unittest
from unittest.mock import Mock,patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import desktop_bridge as bridge


class UnreadRefreshTests(unittest.TestCase):
    def setup_bridge(self):
        b=object.__new__(bridge.Bridge)
        b.targets=[{'id':'group_abao','name':'Example Group A','kind':'group'}]
        b.focus_lease=lambda *_:self.fail('unread navigation must not click or acquire a focus lease')
        return b

    def test_unread_notice_fails_closed_without_mouse_or_foreground(self):
        b=self.setup_bridge()
        for label in ('3条新消息','某人提到了你'):
            button=Mock(ControlTypeName='ButtonControl',Name=label,IsEnabled=True)
            with self.subTest(label=label),patch.object(bridge,'walk_notices',return_value=[button]),\
                 patch.object(bridge.U,'PostMessageW',side_effect=AssertionError('no synthetic click')),\
                 patch.object(bridge,'foreground',side_effect=AssertionError('no activation')):
                with self.assertRaisesRegex(RuntimeError,'手动点未读提示跳到最新'):
                    b.refresh_unread('Example Group A',object(),100)

    def test_no_unread_notice_keeps_viewport_read_automatic(self):
        b=self.setup_bridge()
        with patch.object(bridge,'walk_notices',return_value=[]),patch.object(bridge.U,'PostMessageW',side_effect=AssertionError('no click')):
            self.assertFalse(b.refresh_unread('Example Group A',object(),100))

    def test_unapproved_group_rejected_before_inspecting_controls(self):
        b=self.setup_bridge()
        with patch.object(bridge,'walk_notices',side_effect=AssertionError('unapproved UI read')):
            with self.assertRaises(RuntimeError):b.refresh_unread('Other Group',object(),100)

    def test_send_posts_only_return_to_verified_chat_hwnd(self):
        root,field=Mock(),Mock()
        root.ClassName='mmui::ChatSingleWindow';root.NativeWindowHandle=100
        field.AutomationId='chat_input_field';field.ControlTypeName='EditControl'
        with patch.object(bridge.U,'PostMessageW',return_value=True) as post,\
             patch.object(bridge,'foreground',side_effect=AssertionError('foreground activation')):
            self.assertEqual(bridge.post_target_return(100,root,field),'target_hwnd_return')
            self.assertEqual([c.args for c in post.call_args_list],
                             [(100,0x0100,0x0d,0x001C0001),(100,0x0101,0x0d,0xC01C0001)])
        root.NativeWindowHandle=101
        with patch.object(bridge.U,'PostMessageW',side_effect=AssertionError('must not send')):
            with self.assertRaisesRegex(RuntimeError,'窗口身份变化'):bridge.post_target_return(100,root,field)
        root.NativeWindowHandle=100;field.ControlTypeName='ListControl'
        with patch.object(bridge.U,'PostMessageW',side_effect=AssertionError('must not send')):
            with self.assertRaisesRegex(RuntimeError,'输入框身份变化'):bridge.post_target_return(100,root,field)


if __name__=='__main__':unittest.main()
