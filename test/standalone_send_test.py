"""Verify targeted single-submit without interacting with a real window."""
import sys
import pathlib
import tempfile
import unittest
from contextlib import ExitStack, nullcontext
from types import SimpleNamespace
from unittest.mock import Mock, patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import desktop_bridge as d

def rectangle(box):
    return SimpleNamespace(**dict(zip(('left','top','right','bottom'),box)))

class StandaloneSend(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.main=10;self.hwnd=20;self.pid=123
        self.root=SimpleNamespace(ClassName='mmui::ChatSingleWindow',NativeWindowHandle=20,BoundingRectangle=rectangle((10,10,910,970)))
        self.value=SimpleNamespace(Value='reply')
        self.value.SetValue=lambda text,**_:setattr(self.value,'Value',text)
        self.field=SimpleNamespace(AutomationId='chat_input_field',ControlTypeName='EditControl',BoundingRectangle=rectangle((40,765,870,890)),GetValuePattern=lambda:self.value)
        self.button=SimpleNamespace(ControlTypeName='ButtonControl',Name='发送',IsEnabled=True,BoundingRectangle=rectangle((805,906,877,945)))
        def pid_for(_hwnd,out):
            out._obj.value=self.pid
            return 1
        def placement(_hwnd,out):
            out._obj.rcNormalPosition=d.W.RECT(0,0,920,971)
            return True
        for name,fn in [('GetWindowThreadProcessId',pid_for),('GetWindowPlacement',placement),('GetAncestor',lambda h,k:h),('GetParent',lambda h:0),('GetWindow',lambda h,k:0),('GetWindowLongPtrW',lambda *_:0x08000000),('IsIconic',lambda h:True),('GetForegroundWindow',lambda:90)]:
            self.stack.enter_context(patch.object(d.U,name,side_effect=fn))
        self.stack.enter_context(patch.object(d.auto,'ControlFromHandle',return_value=SimpleNamespace(ClassName='mmui::MainWindow',ControlTypeName='WindowControl',NativeWindowHandle=10)))
        self.stack.enter_context(patch.object(d,'focus_state',return_value={'foregroundPid':999}))
        self.stack.enter_context(patch.object(d,'modifiers_down',return_value=False))
        self.stack.enter_context(patch.object(d,'foreground',side_effect=AssertionError('must not activate')))

    def delivery(self,posts):
        b=object.__new__(d.Bridge);b.main=self.main;b.pid=self.pid
        b.check=lambda *_:None;b.room=lambda *_,**__:(self.root,self.hwnd)
        b.prepare=lambda *_,**__:(self.root,self.field,self.value,self.hwnd)
        b.focus_lease=lambda *_:nullcontext(SimpleNamespace(poll=lambda:None))
        view={'hwnd':self.hwnd,'pid':self.pid,'created':100,'windowBinding':'fixture','continuity':{'mode':'baseline'},'draft':False}
        row={'id':'new','text':'reply','klass':'mmui::ChatTextItemView'}
        b.read=Mock(side_effect=[dict(view,messages=[]),dict(view,messages=[row])])
        self.stack.enter_context(patch.object(d,'unique_in',side_effect=[self.field,self.button]))
        post=self.stack.enter_context(patch.object(d.U,'PostMessageW',side_effect=posts))
        self.stack.enter_context(patch.object(d,'post_target_return',side_effect=AssertionError('must not send twice')))
        return b._send('allowed','reply'),post

    def test_button_commits_once_then_accepts_new_local_echo(self):
        result,post=self.delivery([True,True])
        self.assertEqual(result['status'],'local_echo')
        self.assertEqual([call.args[:3] for call in post.call_args_list],[(20,0x0201,1),(20,0x0202,0)])
        self.assertEqual(post.call_args_list[0].args[3],831|(915<<16))

    def test_button_first_post_rejected_clears_only_owned_draft(self):
        result,post=self.delivery([False])
        self.assertEqual((result['status'],post.call_count,self.value.Value),('not_sent',1,''))

    def test_button_partial_post_preserves_draft_and_never_retries(self):
        result,post=self.delivery([True,False])
        self.assertEqual((result['status'],post.call_count,self.value.Value),('unknown',2,'reply'))

    def test_style_or_geometry_failure_does_not_submit(self):
        self.stack.enter_context(patch.object(d.U,'GetWindowLongPtrW',return_value=0))
        result,post=self.delivery([])
        self.assertEqual((result['status'],post.call_count,self.value.Value),('not_sent',0,''))

    def test_wrong_region_or_geometry_rejected(self):
        self.button.BoundingRectangle=rectangle((10,12,30,20))
        with self.assertRaises(d.NotPosted):d.minimized_send_point(20,self.root,self.field,self.button)
        self.root.BoundingRectangle=rectangle((0,0,150,50))
        with self.assertRaises(d.NotPosted):d.minimized_send_point(20,self.root,self.field,self.button)

    def test_hosted_or_unverified_windows_are_ineligible(self):
        self.assertTrue(d.standalone_minimized_room(10,20,123))
        self.assertFalse(d.standalone_minimized_room(0,20,123))
        self.assertFalse(d.standalone_minimized_room(10,20,777))
        for name,value in [('GetWindow',31),('GetParent',31),('GetAncestor',31),('IsIconic',False)]:
            with self.subTest(name=name),patch.object(d.U,name,return_value=value):
                self.assertFalse(d.standalone_minimized_room(10,20,123))

class EchoEvidence(unittest.TestCase):
    def setUp(self):
        self.anchor=self.text('before')
        self.before=self.snapshot([self.anchor])

    def text(self, row_id, **fields):
        return {'id':row_id,'klass':'mmui::ChatTextItemView','text':'same',**fields}

    def snapshot(self, rows, **overrides):
        return {'messages':rows,'draft':False,'created':100,'pid':7,'hwnd':9,
                'windowBinding':'bound','continuity':{'mode':'overlap'},**overrides}

    def actual(self, *new, **overrides):
        return d.observe_send_echo(self.before,self.snapshot([self.anchor,*new],**overrides),'same')

    def test_unique_text_and_cleared_draft_are_not_author_proof(self):
        report=self.actual(self.text('fresh'))
        self.assertEqual((report['status'],report['ids'],report['echoAuthor'],report['echoEvidence']),
                         ('local_echo',['fresh'],'unavailable','unique_text_and_cleared_draft'))

    def test_explicit_outgoing_direction_can_corroborate_the_observation(self):
        self.assertEqual(self.actual(self.text('self',own=True))['echoAuthor'],'self')

    def test_known_incoming_text_cannot_verify_a_send(self):
        for attrs in ({'own':False},{'role':'user'},{'own':True,'role':'user'}):
            with self.subTest(attrs=attrs):
                self.assertIsNone(self.actual(self.text('peer',**attrs)))

    def test_referenced_or_media_content_is_not_a_text_echo(self):
        for kind in ('mmui::ChatBubbleReferItemView','mmui::ChatVoiceItemView','mmui::ChatImgItemView',''):
            with self.subTest(kind=kind):
                self.assertIsNone(self.actual(self.text('media',klass=kind)))

    def test_older_identical_text_and_uncleared_draft_do_not_confirm(self):
        self.assertIsNone(self.actual())
        self.assertIsNone(self.actual(self.text('fresh'),draft=True))
        self.assertIsNone(self.actual(self.text('fresh'),draft=None))

    def test_multiple_unattributed_candidates_are_ambiguous(self):
        result=self.actual(self.text('first'),self.text('second'))
        self.assertEqual((result['status'],result['ids']),('unknown',[]))

    def test_each_split_send_has_its_own_anchor(self):
        one=self.text('first')
        two=self.text('second')
        first_view=self.snapshot([self.anchor,one])
        self.assertEqual(d.observe_send_echo(self.before,first_view,'same')['ids'],['first'])
        self.assertEqual(d.observe_send_echo(first_view,self.snapshot([self.anchor,one,two]),'same')['ids'],['second'])

    def test_generation_change_even_with_same_text_ends_observation(self):
        for attrs in ({'hwnd':10},{'windowBinding':'other'},{'pid':8},{'created':101}):
            with self.subTest(attrs=attrs):
                self.assertEqual(self.actual(self.text('new'),**attrs)['status'],'unknown')

    def test_gap_recycled_id_or_disappearing_anchor_are_inconclusive(self):
        new=self.text('fresh')
        for view in (self.snapshot([new]),self.snapshot([self.anchor,new],continuity={'mode':'gap'}),
                     self.snapshot([self.anchor,new,new]),self.snapshot([self.anchor,new],continuity={})):
            with self.subTest(view=view):
                self.assertEqual(d.observe_send_echo(self.before,view,'same')['status'],'unknown')


class FocusReceiptTests(unittest.TestCase):
    def test_native_receipt_summarizes_only_observed_foreground(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        for foreground_pid, expected in [(123, True), (777, False), (0, None)]:
            with self.subTest(foreground_pid=foreground_pid), tempfile.TemporaryDirectory(dir=root/'temp') as temp:
                folder = pathlib.Path(temp)
                (folder/'data').mkdir()
                bridge = d.Bridge.__new__(d.Bridge)
                bridge.pid = 123
                bridge._send = Mock(return_value={'status':'local_echo', 'ids':['local']})
                with patch.object(d, 'ROOT', folder), patch.object(d, 'focus_state', return_value={'foregroundPid':foreground_pid}):
                    result = bridge.send('fixture', 'sample')
                self.assertIs(result['wechatForegroundObserved'], expected)
                self.assertNotIn('focusEvents', result)

if __name__=='__main__':unittest.main()
