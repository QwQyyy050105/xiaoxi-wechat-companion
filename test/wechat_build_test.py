"""Check build selection through the Windows adapter's normal entry point."""
import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import desktop_bridge as d
import wechat_build as build


class BuildTests(unittest.TestCase):
    def incoming(self):
        bridge = object.__new__(d.Bridge)
        bridge.config = {'account': {'binding': {'account_folder': 'fixture'}}}
        bridge.targets = []
        fixture = Mock(pid=9)
        fixture.name.return_value = 'Weixin.exe'
        fixture.create_time.return_value = 20
        fixture.exe.return_value = r'D:\Fixture\Weixin.exe'
        self.enterContext(patch.object(d.psutil,'Process',return_value=fixture))
        self.enterContext(patch.object(d,'windows',return_value=[{'pid':9}]))
        self.enterContext(patch.object(d,'identity_folders',return_value=['fixture']))
        return bridge

    def test_new_build_enters_observation_without_starting_guard(self):
        bridge = self.incoming()
        with patch.object(d,'verified_build',return_value='4.3.0.1'), patch.object(d.subprocess,'Popen') as popen:
            status = bridge.connect()
            bridge.check(True)
            self.assertEqual((status['nativeMode'],status['version']),('uia_readonly','4.3.0.1'))
            popen.assert_not_called()

    def test_observation_refuses_mutations_before_any_window_access(self):
        bridge = self.incoming()
        bridge.uia_readonly = True
        for command in ('send','clear_unknown_draft','connect','future_mutation'):
            with self.subTest(command=command), self.assertRaisesRegex(RuntimeError,'仅通过系统无障碍接口观察'):
                bridge.dispatch({'command':command})

    def test_observation_rechecks_account_before_returning_any_message(self):
        bridge = self.incoming()
        with patch.object(d,'verified_build',return_value='4.3.0.1'):
            bridge.connect()
        with patch.object(d,'identity_folders',return_value=['other']), self.assertRaisesRegex(RuntimeError,'身份发生变化'):
            bridge.check(True)

    def test_signed_standalone_build_negotiates_and_sends_via_normal_dispatch(self):
        bridge = self.incoming()
        bridge.send = Mock(return_value={'status':'local_echo'})
        target = {'id':'demo','kind':'group','name':'Demo'}
        with patch.object(d,'authorized_target',return_value=True), patch.object(d,'bound_main_window',return_value=78), patch.object(d,'verified_build',return_value=build.STANDALONE_SEND_BUILD), patch.object(d.subprocess,'Popen') as popen:
            status = bridge.dispatch({'command':'connect','targets':[target]})
            self.assertEqual(status['nativeMode'],'uia_standalone')
            self.assertEqual(bridge.main,78)
            self.assertTrue(bridge.system_uia)
            self.assertFalse(bridge.uia_readonly)
            self.assertTrue(bridge.dispatch({'command':'health'})['healthy'])
            self.assertEqual(bridge.dispatch({'command':'send','group':'Demo','text':'Hello'})['status'],'local_echo')
            bridge.send.assert_called_once_with('Demo','Hello')
            popen.assert_not_called()

    def test_standalone_build_with_unverified_main_remains_read_only(self):
        bridge = self.incoming()
        with patch.object(d,'bound_main_window',return_value=None), patch.object(d,'verified_build',return_value=build.STANDALONE_SEND_BUILD):
            self.assertEqual(bridge.connect()['nativeMode'],'uia_readonly')
        bridge.send = Mock()
        with self.assertRaisesRegex(RuntimeError,'仅通过系统无障碍接口观察'):
            bridge.dispatch({'command':'send','group':'Demo','text':'Hello'})
        bridge.send.assert_not_called()

    def test_verified_build_disallows_other_mutations(self):
        bridge = self.incoming();bridge.system_uia=True;bridge.uia_readonly=False
        for command in ('probe_input','clear_unknown_draft','future_mutation'):
            with self.subTest(command=command), self.assertRaisesRegex(RuntimeError,'只支持绑定群窗'):
                bridge.dispatch({'command':command})

    def test_system_adapter_rejects_group_without_previous_identity(self):
        bridge = self.incoming();bridge.system_uia=True
        bridge.target = Mock(return_value={'name':'Demo','kind':'group'})
        with patch.object(d,'windows') as windows, self.assertRaisesRegex(RuntimeError,'先核对并绑定'):
            bridge.room('Demo')
        windows.assert_not_called()

    def test_system_adapter_expanded_or_hosted_windows_never_fall_back_to_return(self):
        bridge = self.incoming();bridge.system_uia=True;bridge.main=9;bridge.pid=12
        bridge.read=Mock(return_value={'hwnd':11,'draft':False})
        with patch.object(d,'standalone_minimized_room',return_value=False), patch.object(d,'post_target_return') as key, patch.object(d.Bridge,'prepare') as prepare:
            result=bridge._send('Demo','Hello')
        self.assertEqual(result['status'],'deferred')
        prepare.assert_not_called();key.assert_not_called()

    def test_signature_failure_never_launches_guard(self):
        bridge = self.incoming()
        with patch.object(d,'verified_build',side_effect=RuntimeError('签名无效')), patch.object(d.subprocess,'Popen') as popen:
            with self.assertRaisesRegex(RuntimeError,'签名无效'): bridge.connect()
            popen.assert_not_called()

    def test_official_signer_and_numeric_version_required(self):
        for signer, version, code, valid in [
                (build.PUBLISHER,'4.2.0.53',0,True), (build.PUBLISHER,'',0,False),
                (build.PUBLISHER,'wrong',0,False), ('other','4.2.0.53',0,False),
                (build.PUBLISHER,'4.2.0.53',2,False)]:
            response = SimpleNamespace(stdout=(signer+'\n'+version+'\n').encode('ascii'),returncode=code)
            with self.subTest(signer=signer,version=version,code=code), patch.object(build.subprocess,'run',return_value=response):
                if valid: self.assertEqual(build.verified_build(r'D:\Fixture\Weixin.exe'),version)
                else:
                    with self.assertRaisesRegex(RuntimeError,'签名或版本'): build.verified_build(r'D:\Fixture\Weixin.exe')



class FirstGroupBindingTests(unittest.TestCase):
    def setUp(self):
        self.client=object.__new__(d.Bridge)
        self.client.system_uia=True;self.client.uia_readonly=False
        self.client.pid=12;self.client.pending_restores={}
        self.target={'name':'Example','kind':'group','id':'demo'}
        self.client.targets=[self.target]
        self.enterContext(patch.dict(d.AUTHORIZED_GROUPS,{'demo':'Example'},clear=True))
        self.enterContext(patch.dict(d.CONFIG,{'targets':[{'id':'demo','name':'Example','wechatPeerId':'123@chatroom'}]}))
        self.client.check=Mock()
        self.enterContext(patch.object(d,'desktop_ready'))
        self.enumerate=self.enterContext(patch.object(d,'windows',side_effect=AssertionError('must only search the specified title')))
        self.matches=self.enterContext(patch('native_window_restore.matching_windows',return_value={42}))
        self.standalone=self.enterContext(patch('native_window_restore.standalone',return_value=True))
        self.root=SimpleNamespace(ClassName='mmui::ChatSingleWindow',NativeWindowHandle=42,AutomationId='ChatSingleWindow123@chatroom')
        self.control=self.enterContext(patch.object(d.auto,'ControlFromHandle',return_value=self.root))
        self.title=SimpleNamespace(AutomationId='scope.current_chat_name_label',Name='Example',ClassName='label')
        self.chrome=self.enterContext(patch.object(d,'walk_chrome',return_value=[self.title,SimpleNamespace(ClassName='mmui::ChatTitleBarChatRoomView',AutomationId='group_title')]))
        self.client.read=Mock(side_effect=lambda name:{'group':name,'windowBinding':self.target['windowBinding']})

    def open(self):
        return self.client.dispatch({'command':'open','group':'Example','bindOpenGroup':True})

    def assert_unbound(self):
        self.assertNotIn('windowBinding',self.target)
        self.client.read.assert_not_called()

    def test_manual_open_confirms_group_twice_before_persistable_snapshot(self):
        result=self.open()
        self.assertEqual(result['windowBinding'],self.root.AutomationId)
        self.assertEqual(self.target['windowBinding'],self.root.AutomationId)
        self.assertEqual(self.matches.call_count,2)
        self.assertTrue(all(c.args==(12,'Example') for c in self.matches.call_args_list))
        self.assertTrue(all(c.args==(42,) for c in self.control.call_args_list))
        self.assertTrue(all(c.args==(True,) for c in self.client.check.call_args_list))

    def test_only_owner_initiated_open_may_bind_and_version_must_be_verified(self):
        for readonly,manual in [(False,False),(True,True)]:
            self.client.uia_readonly=readonly
            with self.subTest(readonly=readonly,manual=manual),self.assertRaisesRegex(RuntimeError,'先核对并绑定'):
                self.client.room('Example',bind_open_group=manual)
        self.matches.assert_not_called();self.assert_unbound()

    def test_unknown_group_cannot_bind(self):
        with self.assertRaisesRegex(RuntimeError,'授权群'):
            self.client.dispatch({'command':'open','group':'Other','bindOpenGroup':True})
        self.matches.assert_not_called();self.assert_unbound()

    def test_duplicate_title_refused_before_opening_windows(self):
        self.matches.return_value={42,43}
        with self.assertRaisesRegex(RuntimeError,'找到 2 个'): self.open()
        self.control.assert_not_called();self.assert_unbound()

    def test_group_kind_and_title_must_both_match(self):
        self.title.Name='Other'
        with self.assertRaisesRegex(RuntimeError,'群标题不匹配'): self.open()
        self.title.Name='Example';self.chrome.return_value=[self.title]
        with self.assertRaisesRegex(RuntimeError,'会话类型不匹配'): self.open()
        self.assert_unbound()

    def test_configured_peer_or_handle_change_never_pins(self):
        self.root.AutomationId='ChatSingleWindow333@chatroom'
        with self.assertRaisesRegex(RuntimeError,'稳定标识与授权配置不匹配'): self.open()
        self.root.AutomationId='ChatSingleWindow123@chatroom';self.matches.side_effect=[{42},{43}]
        with self.assertRaisesRegex(RuntimeError,'独立窗口发生变化'): self.open()
        self.assert_unbound()

    def test_replacement_window_or_changed_account_cannot_bind(self):
        self.control.side_effect=[self.root,SimpleNamespace(NativeWindowHandle=42,ClassName=self.root.ClassName,AutomationId='Different')]
        with self.assertRaisesRegex(RuntimeError,'群标识发生变化'): self.open()
        self.control.side_effect=None
        self.client.check.side_effect=[None,None,RuntimeError('identity changed')]
        with self.assertRaisesRegex(RuntimeError,'identity changed'): self.open()
        self.assert_unbound()

    def test_embedded_window_cannot_bind(self):
        self.standalone.return_value=False
        with self.assertRaisesRegex(RuntimeError,'群独立窗口'): self.open()
        self.assert_unbound()
