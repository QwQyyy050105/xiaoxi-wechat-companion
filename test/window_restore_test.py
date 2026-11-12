"""Offline recovery of one previously bound, independently hosted WeChat group."""
import contextlib
import json
import pathlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import native_window_restore as restore


class WindowRestore(unittest.TestCase):
    def setUp(self):
        self.stack=self.enterContext(contextlib.ExitStack())
        folder=pathlib.Path(self.enterContext(tempfile.TemporaryDirectory(dir=ROOT/'temp')))
        self.receipt=folder/'receipt.json'
        self.target=dict(id='room',name='Example',kind='group')
        self.bridge=Mock(main=10,pid=20,created=123.0)
        self.lease=Mock()
        self.lease.poll.return_value=None
        self.bridge.focus_lease.return_value=contextlib.nullcontext(self.lease)
        self.bridge.room.return_value=SimpleNamespace(AutomationId='ChatSingleWindow1',NativeWindowHandle=30,ClassName='mmui::ChatSingleWindow'),30
        self.control=Mock(return_value=SimpleNamespace(ClassName='mmui::MainWindow',NativeWindowHandle=10,ControlTypeName='WindowControl'))
        self.row=Mock()
        self.focus={'foreground':40,'foregroundPid':41,'lastInputTick':99}
        self.clock=self.patch(restore,'TICK_COUNT',return_value=61_000)
        self.patch(restore,'standalone',return_value=True)
        self.patch(restore,'title',return_value='微信')
        self.patch(restore,'owned_windows',return_value={10})
        self.match=self.patch(restore,'matching_windows',side_effect=[set(),set(),{30}])
        self.point=self.patch(restore,'row_point',return_value=(1234,144,(10,20),(30,40),(30,40)))
        self.post=self.patch(restore,'post_row')
        self.patch(restore.USER,'GetWindowLongPtrW',return_value=0x08000000)
        self.icon=self.patch(restore.USER,'IsIconic',side_effect=[False,True])
        self.show=self.patch(restore.USER,'ShowWindow')

    def patch(self,obj,name,**kwargs):
        return self.stack.enter_context(patch.object(obj,name,**kwargs))

    def run_restore(self,binding='ChatSingleWindow1'):
        restore.restore_group(self.bridge,self.target,binding,self.control,lambda root,name:self.row,lambda:dict(self.focus),lambda:None,self.receipt)

    def test_only_new_verified_bound_window_is_minimized_without_activation(self):
        self.run_restore()
        self.post.assert_called_once_with(10,1234)
        self.show.assert_called_once_with(30,7)
        self.assertTrue(json.loads(self.receipt.read_text())['minimized'])

    def test_foreground_wechat_is_left_alone(self):
        self.focus['foregroundPid']=20
        with self.assertRaises(restore.WaitForIdle): self.run_restore()
        self.post.assert_not_called()

    def test_owner_typing_before_setup_defers_until_idle(self):
        self.clock.return_value=1_000
        with self.assertRaises(restore.WaitForIdle):self.run_restore()
        self.post.assert_not_called()
        self.point.assert_not_called()
        self.clock.return_value=62_000
        self.run_restore()
        self.post.assert_called_once()

    def test_owner_resumes_activity_during_geometry_check(self):
        self.point.side_effect=lambda *_:self.focus.update(lastInputTick=60_000) or (1234,144)
        with self.assertRaises(restore.WaitForIdle):self.run_restore()
        self.post.assert_not_called()

    def test_idle_check_handles_tick_wraparound_and_unknown_input(self):
        self.clock.return_value=65_000
        restore.require_idle({'lastInputTick':0xfffffff0})
        for tick in (0,None,65_000,65_001):
            with self.assertRaises(restore.WaitForIdle):restore.require_idle({'lastInputTick':tick})

    def test_missing_prior_binding_and_unsafe_hit_point_never_post(self):
        with self.assertRaises(RuntimeError): self.run_restore(None)
        self.point.side_effect=RuntimeError('clipped')
        with self.assertRaises(RuntimeError): self.run_restore()
        self.post.assert_not_called()

    def test_window_opened_concurrently_is_not_minimized_or_invoked(self):
        self.match.side_effect=None
        self.match.return_value={50}
        with self.assertRaises(RuntimeError): self.run_restore()
        self.post.assert_not_called()
        self.show.assert_not_called()

    def test_user_input_in_new_window_stops_after_single_post(self):
        self.post.side_effect=lambda *args:self.focus.update(foreground=30,foregroundPid=20,lastInputTick=100)
        with self.assertRaises(RuntimeError): self.run_restore()
        self.show.assert_not_called()
        self.assertTrue(json.loads(self.receipt.read_text())['focusChanged'])

    def test_new_window_self_activation_can_be_minimized_and_is_reported(self):
        self.post.side_effect=lambda *args:self.focus.update(foreground=30,foregroundPid=20)
        self.run_restore()
        self.show.assert_called_once_with(30,7)
        self.assertTrue(json.loads(self.receipt.read_text())['focusChanged'])

    def test_typing_and_switching_other_apps_does_not_starve_the_bound_row(self):
        self.post.side_effect=lambda *args:self.focus.update(lastInputTick=100,foreground=90,foregroundPid=700)
        self.run_restore()
        self.show.assert_called_once_with(30,7)

    def test_different_bound_peer_is_never_touched_and_attempt_is_not_repeated(self):
        self.bridge.room.return_value[0].AutomationId='ChatSingleWindow2'
        with self.assertRaises(RuntimeError): self.run_restore()
        self.show.assert_not_called()
        with self.assertRaisesRegex(RuntimeError,'未重复触发'): self.run_restore()
        self.post.assert_called_once()

    def test_window_is_not_minimized_after_lease_ended(self):
        self.lease.poll.return_value=1
        with self.assertRaises(RuntimeError): self.run_restore()
        self.post.assert_not_called()
        self.show.assert_not_called()

    def test_scrolled_row_between_reads_is_not_clicked(self):
        self.point.side_effect=[(100,), (200,)]
        with self.assertRaises(RuntimeError): self.run_restore()
        self.post.assert_not_called()

class IdlePoll(unittest.TestCase):
    def setUp(self):
        import desktop_bridge as bridge
        self.module=bridge
        self.client=object.__new__(bridge.Bridge)
        self.client.pid=20
        self.client.main=10
        self.client.pending_restores={}
        self.client.restore_targets={'example'}
        self.client.target=lambda name:{'name':name,'id':'example','kind':'group','peerId':'ChatSingleWindow1','windowBinding':'ChatSingleWindow1'}
        self.client.check=Mock()
        self.client.read=Mock(return_value={'ok':True})

    def test_busy_start_arms_once_then_first_idle_poll_opens(self):
        with patch.object(self.module,'windows',return_value=[]),patch.object(restore,'restore_group',side_effect=[restore.WaitForIdle('busy'),None]) as opener:
            with self.assertRaises(restore.WaitForIdle):self.client.open_room('Example',True)
            self.assertIn('Example',self.client.pending_restores)
            with patch.object(restore,'matching_windows') as lookup:
                with self.assertRaisesRegex(RuntimeError,'60 秒'):self.client.poll_room('Example')
                lookup.assert_not_called()
            self.client.pending_restores['Example']=0
            with patch.object(restore,'matching_windows',return_value=set()),patch.object(self.module,'focus_state',return_value={}),patch.object(restore,'require_idle'):
                self.assertEqual(self.client.poll_room('Example'),{'ok':True})
            self.client.poll_room('Example')
        self.assertEqual(opener.call_count,2)
        self.assertEqual(self.client.pending_restores,{})

    def test_manual_open_before_idle_cancels_pending_without_action(self):
        self.client.pending_restores['Example']=0
        with patch.object(restore,'matching_windows',return_value={11}),patch.object(self.module,'windows',return_value=[{'title':'Example'}]),patch.object(restore,'restore_group') as opener:
            self.client.poll_room('Example')
        self.assertEqual(self.client.pending_restores,{})
        opener.assert_not_called()

    def test_pending_is_disarmed_on_unknown_delivery_and_on_passive_reconnect(self):
        self.client.pending_restores['Example']=0
        with patch.object(restore,'matching_windows',return_value=set()),patch.object(self.module,'focus_state',return_value={}),patch.object(restore,'require_idle'),patch.object(self.module,'windows',return_value=[]),patch.object(restore,'restore_group',side_effect=RuntimeError('uncertain')) as opener:
            with self.assertRaisesRegex(RuntimeError,'uncertain'):self.client.poll_room('Example')
            self.assertEqual(self.client.pending_restores,{})
            self.client.poll_room('Example')
            with self.assertRaisesRegex(RuntimeError,'手动打开'):self.client.open_room('Example',False)
            opener.assert_called_once()

class SessionPoint(unittest.TestCase):
    def test_physical_pixels_and_full_viewport_are_required(self):
        def rec(bounds):return SimpleNamespace(left=bounds[0],top=bounds[1],right=bounds[2],bottom=bounds[3])
        root=SimpleNamespace(NativeWindowHandle=10,BoundingRectangle=rec((100,50,1100,850)))
        lst=SimpleNamespace(ClassName='mmui::XTableView',ControlTypeName='ListControl',IsOffscreen=False,BoundingRectangle=rec((160,170,510,835)))
        row=Mock(AutomationId='session_item_Example',ClassName='mmui::ChatSessionCell',ControlTypeName='ListItemControl',IsOffscreen=False,IsEnabled=True)
        row.BoundingRectangle=rec((160,210,510,307))
        row.GetParentControl.return_value=lst
        row.GetLegacyIAccessiblePattern.return_value=SimpleNamespace(DefaultAction='双击')
        def placement(h,p):
            n=p._obj.rcNormalPosition
            n.left,n.top,n.right,n.bottom=89,51,1111,862
            return True
        with contextlib.ExitStack() as stack:
            for name,val in [('GetWindowDpiAwarenessContext',1),('GetThreadDpiAwarenessContext',1),('GetAwarenessFromDpiAwarenessContext',2),('GetDpiForWindow',144),('GetClassLongPtrW',8),('IsIconic',True)]:
                stack.enter_context(patch.object(restore.USER,name,return_value=val))
            stack.enter_context(patch.object(restore.USER,'GetWindowPlacement',side_effect=placement))
            self.assertEqual(restore.row_point(root,row,'Example')[0],235|(208<<16))
            row.BoundingRectangle=rec((160,140,510,237))
            with self.assertRaises(RuntimeError):restore.row_point(root,row,'Example')
    def test_target_messages_follow_standard_double_click_order_without_system_input(self):
        with patch.object(restore.USER,'PostMessageW',return_value=True) as post:
            restore.post_row(90,124)
        self.assertEqual([c.args for c in post.call_args_list],[(90,0x201,1,124),(90,0x202,0,124),(90,0x203,1,124),(90,0x202,0,124)])
