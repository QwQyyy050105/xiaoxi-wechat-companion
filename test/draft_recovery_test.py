import hashlib
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from native_draft_recovery import clear_verified_draft

class Field:
    def __init__(self, text='43'):
        self.Value = text
        self.writes = []
    def SetValue(self, text, waitTime):
        self.writes.append(text)
        self.Value = text

class DraftRecovery(unittest.TestCase):
    def setUp(self):
        self.field = Field()
        self.rows = [('scope.id','mmui::ChatTextItemView','test question')]
        self.req = dict(text='43', anchorId='scope.id',anchorClass=self.rows[0][1],
                        anchorHash=hashlib.sha256(b'test question').hexdigest())
    def run_clear(self, check=lambda: None):
        return clear_verified_draft(self.req, lambda: (self.rows,self.field), check)
    def test_clears_exact_draft(self):
        self.assertTrue(self.run_clear()['cleared'])
        self.assertEqual(self.field.writes, [''])
    def test_preserves_user_edits(self):
        for text in ('', ' 43', '43\n'):
            self.field.Value=text
            with self.assertRaises(RuntimeError): self.run_clear()
        self.assertEqual(self.field.writes, [])
    def test_concurrent_new_bubble_refuses(self):
        with self.assertRaises(RuntimeError):
            self.run_clear(lambda: self.rows.append(('reply', self.rows[0][1], '43')))
        self.assertEqual(self.field.writes, [])
    def test_preceding_identical_message_is_not_a_new_echo(self):
        self.rows.insert(0, ('old',self.rows[0][1],'43'))
        self.assertTrue(self.run_clear()['cleared'])
    def test_recycled_native_id_or_changed_group_refuses(self):
        self.rows[0]=(self.rows[0][0],self.rows[0][1],'other question')
        with self.assertRaises(RuntimeError): self.run_clear()
        self.assertEqual(self.field.writes, [])
    def test_edited_during_recheck_refuses(self):
        with self.assertRaises(RuntimeError):
            self.run_clear(lambda: setattr(self.field,'Value','43 edited'))
        self.assertEqual(self.field.writes, [])
    @unittest.skipUnless(sys.platform=='win32','Windows native dispatch')
    def test_private_voice_scope_checked_before_touching_window(self):
        import desktop_bridge
        bridge=object.__new__(desktop_bridge.Bridge)
        bridge.target=lambda group:{'id':'disabled'}
        bridge.voice_targets=frozenset()
        bridge.room=lambda *a,**k:self.fail('out-of-scope window opened')
        for kind in ('mmui::ChatVoiceItemView','unknown'):
            with self.assertRaisesRegex(RuntimeError,'不支持|未启用'):
                bridge.dispatch(dict(command='clear_unknown_draft',group='example',targetId='disabled',anchorClass=kind))

    @unittest.skipUnless(sys.platform=='win32','Windows native dispatch')
    def test_native_cleanup_holds_lease_through_set_and_readback(self):
        from contextlib import contextmanager
        from types import SimpleNamespace
        from unittest.mock import patch
        import desktop_bridge as native
        bridge=object.__new__(native.Bridge)
        bridge.pid,bridge.created=5,47
        bridge.target=lambda name:{'id':'target'}
        bridge.check=lambda *args:None
        req=dict(self.req,group='test',targetId='target',pid=5,created=47,hwnd=19,binding='room',anchorId='2.1')
        module=self
        for fail_after in (False,True):
            state={'guard':False,'written':False}
            @contextmanager
            def lease(name,hwnd):
                self.assertEqual((name,hwnd),('test',19))
                state['guard']=True
                try:yield SimpleNamespace(poll=lambda:None)
                finally:state['guard']=False
            bridge.focus_lease=lease
            class Edit(Field):
                def SetValue(self, text, waitTime):
                    module.assertTrue(state['guard'])
                    state['written']=True
                    super().SetValue(text,waitTime)
            field=Edit()
            root=SimpleNamespace(AutomationId='room')
            rows=SimpleNamespace(AutomationId='chat_message_list')
            edit=SimpleNamespace(AutomationId='chat_input_field',ControlTypeName='EditControl',GetValuePattern=lambda:field)
            bubble=SimpleNamespace(ClassName=req['anchorClass'],Name='test question',GetRuntimeId=lambda:[2,1])
            def room(name,chrome_out=None):
                if chrome_out is not None:
                    self.assertTrue(state['guard'])
                    if fail_after and state['written']:raise RuntimeError('provider busy')
                    chrome_out.extend([rows,edit])
                return root,19
            bridge.room=room
            with patch.object(native,'walk_notices',return_value=[]),patch.object(native,'message_bubbles',return_value=[bubble]),patch.object(native,'focus_state',return_value={'foregroundPid':1}),patch.object(native.U,'GetWindowLongPtrW',return_value=0x08000000):
                if fail_after:
                    with self.assertRaisesRegex(RuntimeError,'已尝试清理，结果待核对'):bridge.clear_unknown_draft(req)
                else:
                    class RecycledVoice:
                        ClassName='mmui::ChatVoiceItemView'
                        def GetRuntimeId(self): return [2,1]
                        @property
                        def Name(self): raise AssertionError('accessed disabled voice content')
                    bridge.voice_targets=frozenset()
                    with patch.object(native,'message_bubbles',return_value=[RecycledVoice()]):
                        with self.assertRaisesRegex(RuntimeError,'原来信.*变化'):
                            bridge.clear_unknown_draft(req)
                    self.assertEqual(field.writes,[])
                    self.assertTrue(bridge.clear_unknown_draft(req)['cleared'])
            self.assertFalse(state['guard'])
            self.assertEqual(field.writes,[''])

if __name__=='__main__':
    unittest.main()
