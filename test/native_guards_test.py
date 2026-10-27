# Install the committed fictional registry before importing production adapters.
import pathlib as _test_pathlib
import sys as _test_sys
_test_sys.path.insert(0, str(_test_pathlib.Path(__file__).resolve().parent))
from native_test_bootstrap import configure_test_environment
configure_test_environment()

import sys, pathlib, unittest
from contextlib import contextmanager
from unittest.mock import patch, Mock
from types import SimpleNamespace
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
from desktop_bridge import Bridge

class IdentityDiagnostics(unittest.TestCase):
    def bridge(self):
        b=object.__new__(Bridge)
        b.config={'account':{'binding':{'account_folder':'wxid_spare'}}}
        b.pid=20;b.created=100;b.guard=Mock();b.guard.poll.return_value=None;b.last_identity=7
        return b

    def process(self,pid=20,folder='wxid_spare'):
        p=Mock();p.pid=pid;p.name.return_value='Weixin.exe';p.create_time.return_value=100
        p.open_files.return_value=[SimpleNamespace(path='D:\\xwechat_files\\'+folder+'\\db_storage\\message\\message_0.db')]
        return p

    def connect_error(self,processes):
        import desktop_bridge as d
        b=self.bridge();rows=[{'pid':pid,'hwnd':pid+100,'title':'微信','width':900,'height':700} for pid in processes]
        with patch.object(d,'windows',return_value=rows),patch.object(d.psutil,'Process',side_effect=lambda pid:processes[pid]),patch.object(d.subprocess,'Popen',side_effect=AssertionError('must not start a real guard')):
            with self.assertRaises(RuntimeError) as error:b.connect()
        return str(error.exception)

    def test_connect_permission_denial_is_not_reported_as_logged_out_or_zero_matches(self):
        import desktop_bridge as d
        for field in ('name','open_files'):
            p=self.process();getattr(p,field).side_effect=d.psutil.AccessDenied(pid=p.pid)
            message=self.connect_error({p.pid:p})
            self.assertIn('访问权限不足',message);self.assertIn('暂时无法核验Example Account身份',message)
            self.assertNotIn('匹配账号数',message);self.assertNotIn('等待登录',message)

    def test_readable_other_account_does_not_hide_a_denied_candidate(self):
        import desktop_bridge as d
        denied=self.process(21);denied.open_files.side_effect=d.psutil.AccessDenied(pid=21)
        self.assertIn('访问权限不足',self.connect_error({20:self.process(20,'wxid_main'),21:denied}))

    def test_known_mismatch_and_absent_windows_keep_normal_account_binding_failure(self):
        for processes in ({20:self.process(20,'wxid_main')},{}):
            message=self.connect_error(processes)
            self.assertIn('匹配账号数：0',message);self.assertNotIn('访问权限不足',message)

    def test_process_creation_metadata_denial_stops_before_starting_guard(self):
        import desktop_bridge as d
        p=self.process();p.create_time.side_effect=d.psutil.AccessDenied(pid=20)
        self.assertIn('访问权限不足',self.connect_error({20:p}))

    def test_check_denial_keeps_identity_unverified_and_does_not_refresh_success_cache(self):
        import desktop_bridge as d
        for field in ('name','create_time','open_files'):
            b=self.bridge();p=self.process();getattr(p,field).side_effect=d.psutil.AccessDenied(pid=20)
            with patch.object(d.psutil,'Process',return_value=p),patch.object(d.time,'monotonic',return_value=123):
                with self.assertRaisesRegex(RuntimeError,'访问权限不足.*暂时无法核验Example Account身份'):b.check(True)
            self.assertEqual(b.last_identity,7)

    def test_check_still_rejects_a_readable_wrong_account(self):
        import desktop_bridge as d
        b=self.bridge()
        with patch.object(d.psutil,'Process',return_value=self.process(folder='wxid_main')):
            with self.assertRaisesRegex(RuntimeError,'身份发生变化'):b.check(True)
        self.assertEqual(b.last_identity,7)

    def test_check_reports_disappeared_process_as_exit(self):
        import desktop_bridge as d
        b=self.bridge()
        with patch.object(d.psutil,'Process',side_effect=d.psutil.NoSuchProcess(pid=20)):
            with self.assertRaisesRegex(RuntimeError,'微信已退出'):b.check(True)

    def test_readable_exact_binding_still_passes_and_refreshes_cache(self):
        import desktop_bridge as d
        b=self.bridge()
        with patch.object(d.psutil,'Process',return_value=self.process()),patch.object(d.time,'monotonic',return_value=123):b.check(True)
        self.assertEqual(b.last_identity,123)

    def test_idle_health_checks_process_guard_and_expiring_account_binding(self):
        import desktop_bridge as d
        b=self.bridge();process=self.process()
        with patch.object(d.psutil,'Process',return_value=process),patch.object(d.time,'monotonic',return_value=8):
            self.assertEqual(b.dispatch({'command':'health'}), {'healthy':True})
            process.open_files.assert_not_called()
            process.name.assert_called()
            process.create_time.assert_called()
            b.guard.poll.assert_called()
        with patch.object(d.psutil,'Process',return_value=process),patch.object(d.time,'monotonic',return_value=18):
            self.assertEqual(b.dispatch({'command':'health'}), {'healthy':True})
            process.open_files.assert_called_once()
        b.guard.poll.return_value=1
        with patch.object(d.psutil,'Process',return_value=process),self.assertRaisesRegex(RuntimeError,'兼容接口已停止'):
            b.dispatch({'command':'health'})

class Guards(unittest.TestCase):
    def test_connect_scope_rejects_private_or_spoofed_target_before_native_access(self):
        b=object.__new__(Bridge)
        b.targets=[{'id':'group_abao','name':'Example Group A','kind':'group'}]
        b.connect=lambda:self.fail('must reject before native connect')
        for target in [{'id':'private','name':'文件传输助手','kind':'contact'},
                       {'id':'group_abao','name':'其他群','kind':'group'},
                       {'id':'group_family','name':'Example Group A','kind':'group'},
                       {'id':'group_abao','name':'Example Group A','kind':'contact'},
                       {'id':[],'name':'Example Group A','kind':'group'}]:
            with self.assertRaisesRegex(RuntimeError,'授权范围'):b.dispatch({'command':'connect','targets':[target]})

    def test_two_authorized_groups_reach_connect_without_widening_scope(self):
        b=object.__new__(Bridge);b.targets=[];b.connect=lambda:{'connected':True}
        targets=[{'id':'group_abao','name':'Example Group A','kind':'group'},
                 {'id':'group_family','name':'Example Group B','kind':'group'}]
        self.assertEqual(b.dispatch({'command':'connect','targets':targets}),{'connected':True})
        self.assertEqual(b.target('Example Group B'),targets[1])
        with self.assertRaisesRegex(RuntimeError,'授权群'):b.target('文件传输助手')

    def test_unconfigured_and_ambiguous_targets_stop_before_access(self):
        b=object.__new__(Bridge);b.targets=[{'name':'allowed','kind':'group'}]
        with self.assertRaises(RuntimeError):b.target('main_account_private_chat')
        b.targets.append({'name':'allowed','kind':'contact'})
        with self.assertRaises(RuntimeError):b.target('allowed')

    def test_changed_identity_prevents_input(self):
        b=object.__new__(Bridge)
        def fail(*_):raise RuntimeError('identity_changed')
        b.check=fail
        b.room=lambda *_:self.fail('must not access input after identity mismatch')
        with self.assertRaisesRegex(RuntimeError,'identity_changed'):b.prepare('allowed','hello')

    def test_existing_manual_draft_is_never_overwritten(self):
        import desktop_bridge
        b=object.__new__(Bridge);b.check=lambda *_:None;b.room=lambda *_:(object(),1)
        class Pattern:
            Value='my manual draft'
            def SetValue(self,*_):raise AssertionError('manual draft overwritten')
        class Field:
            def GetValuePattern(self):return Pattern()
        original=desktop_bridge.unique_chrome;desktop_bridge.unique_chrome=lambda *_:Field()
        try:
            with self.assertRaisesRegex(RuntimeError,'手动草稿'):b.prepare('allowed','hello')
        finally:desktop_bridge.unique_chrome=original

    def test_recreated_window_is_rejected_before_setting_value(self):
        b=object.__new__(Bridge);b.check=lambda *_:None;b.room=lambda *_:(object(),2)
        with self.assertRaisesRegex(RuntimeError,'窗口已更换'):b.prepare('allowed','hello',expected_hwnd=1)

    def test_background_send_protects_input_until_echo_and_never_activates(self):
        import desktop_bridge as d
        b=object.__new__(Bridge);events=[]
        class Guard:
            def poll(self):return None
        class Pattern:
            Value='hello'
        class Button:IsEnabled=True
        @contextmanager
        def lease(*_):
            events.append('acquire');yield Guard();events.append('restore')
        b.focus_lease=lease;b.check=lambda *_:None;b.room=lambda *_:(object(),1)
        reads=[{'messages':[],'draft':False},{'messages':[{'id':'new','text':'hello'}],'draft':False}]
        b.read=lambda *_:reads.pop(0)
        def prepare(*_,**kwargs):
            self.assertEqual(kwargs['expected_hwnd'],1);events.append('prepare');return object(),object(),Pattern(),1
        b.prepare=prepare
        with patch.object(d.U,'GetForegroundWindow',return_value=2),patch.object(d,'unique',return_value=Button()),patch.object(d,'post_send_button',side_effect=lambda *_:events.append('post')),patch.object(d,'foreground',side_effect=AssertionError('foreground activation')):
            self.assertEqual(b._send('allowed','hello')['status'],'local_echo')
        self.assertEqual(events,['acquire','prepare','post','restore'])

    def test_manual_draft_or_active_target_defers_without_input_or_lease(self):
        import desktop_bridge as d
        for draft,foreground in [(True,2),(False,1)]:
            b=object.__new__(Bridge);b.read=lambda *_:{'messages':[],'draft':draft};b.room=lambda *_:(object(),1)
            b.focus_lease=lambda *_:self.fail('must not acquire or type')
            with patch.object(d.U,'GetForegroundWindow',return_value=foreground):self.assertEqual(b._send('allowed','hello')['status'],'deferred')

    def test_partial_post_failure_remains_unknown_and_draft_is_not_cleared(self):
        import desktop_bridge as d
        b=object.__new__(Bridge)
        class Guard:
            def poll(self):return None
        class Pattern:
            Value='hello'
            def SetValue(self,*_,**__):raise AssertionError('ambiguous draft cleared')
        class Button:IsEnabled=True
        @contextmanager
        def lease(*_):yield Guard()
        b.focus_lease=lease;b.check=lambda *_:None;b.room=lambda *_:(object(),1)
        b.read=lambda *_:{'messages':[],'draft':False};b.prepare=lambda *_,**__:(object(),object(),Pattern(),1)
        with patch.object(d.U,'GetForegroundWindow',return_value=2),patch.object(d,'unique',return_value=Button()),patch.object(d,'post_send_button',side_effect=RuntimeError('up rejected')):
            self.assertEqual(b._send('allowed','hello')['status'],'unknown')

    def test_modifier_key_defers_before_draft_or_commit(self):
        import desktop_bridge as d
        b=object.__new__(Bridge);b.read=lambda *_:{'messages':[],'draft':False};b.room=lambda *_:(object(),1)
        b.focus_lease=lambda *_:self.fail('must not acquire while a shortcut is held')
        with patch.object(d.U,'GetForegroundWindow',return_value=2),patch.object(d,'modifiers_down',return_value=True):
            self.assertEqual(b._send('allowed','hello')['status'],'deferred')

    def test_new_shortcut_during_preparation_defers_only_after_owned_draft_clears(self):
        import desktop_bridge as d
        for clear_works in (True,False):
            b=object.__new__(Bridge)
            class Guard:
                def poll(self):return None
            class Pattern:
                Value='hello'
                def SetValue(self,text,**_):
                    if clear_works:self.Value=text
            class Button:IsEnabled=True
            pattern=Pattern()
            @contextmanager
            def lease(*_):yield Guard()
            b.focus_lease=lease;b.check=lambda *_:None;b.room=lambda *_:(object(),1)
            b.read=lambda *_:{'messages':[],'draft':False};b.prepare=lambda *_,**__:(object(),object(),pattern,1)
            with patch.object(d.U,'GetForegroundWindow',return_value=2),patch.object(d,'modifiers_down',side_effect=[False,True]),patch.object(d,'unique',return_value=Button()),patch.object(d,'post_send_button',side_effect=AssertionError('must not commit')):
                result=b._send('allowed','hello')
            self.assertEqual(result['status'],'deferred' if clear_works else 'not_sent')
            self.assertEqual(pattern.Value,'' if clear_works else 'hello')

class MetadataControl:
    """Offline UIA stand-in; private content access raises immediately."""
    def __init__(self,automation_id='',klass='QWidget',role='PaneControl',children=(),forbid_children=False,name=None):
        self.AutomationId=automation_id;self.ClassName=klass;self.ControlTypeName=role
        self.children=list(children);self.forbid_children=forbid_children;self.children_reads=0;self._name=name;self.clicked=False
    @property
    def Name(self):
        if self._name is None:raise AssertionError('must not read arbitrary Name or session preview')
        return self._name
    def GetChildren(self):
        self.children_reads+=1
        if self.forbid_children:raise AssertionError('must not enumerate private content subtree')
        return self.children
    def DoubleClick(self,**_):self.clicked=True

class NavigationPrivacy(unittest.TestCase):
    def navigation(self):
        target=MetadataControl('session_item_Example Group A',role='ListItemControl',forbid_children=True)
        other=MetadataControl('session_item_私人联系人',role='ListItemControl',forbid_children=True)
        sessions=MetadataControl('session_list',klass='mmui::SessionListView',role='ListControl',children=[other,target])
        messages=MetadataControl('chat_message_list',klass='mmui::MessageListView',role='ListControl',forbid_children=True)
        draft=MetadataControl('chat_input_field',role='EditControl',forbid_children=True)
        contacts=MetadataControl('contact_list',klass='mmui::ContactListView',role='ListControl',forbid_children=True)
        document=MetadataControl('web_document',role='DocumentControl',forbid_children=True)
        root=MetadataControl('main',klass='mmui::MainWindow',role='WindowControl',children=[messages,draft,contacts,document,sessions])
        return root,target,other,messages,draft,contacts,document

    def test_navigation_reads_only_structure_and_never_previews_or_other_conversation_content(self):
        import desktop_bridge as d
        root,target,other,messages,draft,contacts,document=self.navigation()
        self.assertIs(d.authorized_session_item(root,'Example Group A'),target)
        for node in (target,other,messages,draft,contacts,document):self.assertEqual(node.children_reads,0)

    def test_unknown_list_layout_fails_without_expanding_it_or_falling_back_to_full_tree(self):
        import desktop_bridge as d
        unknown=MetadataControl('unknown_list',role='ListControl',forbid_children=True)
        root=MetadataControl('main',role='WindowControl',children=[unknown])
        with self.assertRaisesRegex(RuntimeError,'导航结构未验证'):d.authorized_session_item(root,'Example Group B')
        self.assertEqual(unknown.children_reads,0)

    def test_session_label_cannot_override_contact_or_document_privacy_boundary(self):
        import desktop_bridge as d
        for unknown in (
            MetadataControl('contact_session_list',klass='mmui::ContactSessionListView',role='ListControl',forbid_children=True),
            MetadataControl('session_list',role='DocumentControl',forbid_children=True),
        ):
            root=MetadataControl('main',role='WindowControl',children=[unknown])
            with self.assertRaisesRegex(RuntimeError,'导航结构未验证'):d.authorized_session_item(root,'Example Group B')
            self.assertEqual(unknown.children_reads,0)

    def test_unapproved_navigation_stops_before_touching_root(self):
        import desktop_bridge as d
        with self.assertRaisesRegex(RuntimeError,'授权群'):d.authorized_session_item(object(),'私人联系人')

    def test_same_target_outside_session_list_is_not_a_navigation_authorization(self):
        import desktop_bridge as d
        fake=MetadataControl('session_item_Example Group B',role='ListItemControl',forbid_children=True)
        root=MetadataControl('main',role='WindowControl',children=[fake])
        with self.assertRaisesRegex(RuntimeError,'导航结构未验证'):d.authorized_session_item(root,'Example Group B')
        self.assertEqual(fake.children_reads,0)

    def test_duplicate_navigation_target_and_excessive_structure_fail_closed(self):
        import desktop_bridge as d
        item=lambda:MetadataControl('session_item_Example Group B',role='ListItemControl',forbid_children=True)
        root=MetadataControl('session_list',role='ListControl',children=[item(),item()])
        with self.assertRaisesRegex(RuntimeError,'不唯一'):d.authorized_session_item(root,'Example Group B')
        with self.assertRaisesRegex(RuntimeError,'数量异常'):d.authorized_session_item(root,'Example Group B',limit=1)

    def test_independent_window_identity_does_not_enumerate_messages_before_group_kind_check(self):
        import desktop_bridge as d
        for is_group in (True,False):
            b=object.__new__(Bridge);b.pid=20;b.targets=[{'id':'group_abao','name':'Example Group A','kind':'group','wechatPeerId':'10000001@chatroom'}];b.check=lambda *_:None
            messages=MetadataControl('chat_message_list',role='ListControl',forbid_children=True)
            title=MetadataControl('target.current_chat_name_label',role='TextControl',name='Example Group A')
            header=MetadataControl('header',klass='mmui::ChatTitleBarChatRoomView' if is_group else 'mmui::PrivateChatTitleBar',children=[title])
            root=MetadataControl('ChatSingleWindow123',klass='mmui::ChatSingleWindow',role='WindowControl',children=[messages,header])
            with patch.object(d,'windows',return_value=[{'pid':20,'title':'Example Group A','hwnd':1}]),patch.object(d,'desktop_ready'),patch.object(d.auto,'ControlFromHandle',return_value=root):
                if is_group:
                    self.assertEqual(b.room('Example Group A'),(root,1))
                    self.assertEqual(b.targets[0]['windowBinding'],'ChatSingleWindow123')
                    self.assertEqual(b.targets[0]['wechatPeerId'],'10000001@chatroom')
                else:
                    with self.assertRaisesRegex(RuntimeError,'会话类型不匹配'):b.room('Example Group A')
            self.assertEqual(messages.children_reads,0)

    def test_bound_target_title_survives_shared_message_class_and_text_control_containers(self):
        import desktop_bridge as d
        for role in ('TextControl','EditControl','DocumentControl','ImageControl','PaneControl'):
            with self.subTest(role=role):
                b=object.__new__(Bridge);b.pid=20;b.targets=[{'id':'group_abao','name':'Example Group A','kind':'group','windowBinding':'ChatSingleWindow123'}];b.check=lambda *_:None
                messages=MetadataControl('chat_message_list',role='ListControl',forbid_children=True)
                draft=MetadataControl('chat_input_field',role='EditControl',forbid_children=True)
                bubble=MetadataControl('item.chat_bubble_item_view',forbid_children=True)
                title=MetadataControl('target.current_chat_name_label',role='TextControl',name='Example Group A')
                header=MetadataControl('header',klass='mmui::ChatTitleBarChatRoomView',children=[title])
                container=MetadataControl('shared_chrome',klass='mmui::ChatMessageView',role=role,children=[header,messages,draft,bubble])
                root=MetadataControl('ChatSingleWindow123',klass='mmui::ChatSingleWindow',role='WindowControl',children=[container])
                with patch.object(d,'windows',return_value=[{'pid':20,'title':'Example Group A','hwnd':1}]),patch.object(d,'desktop_ready'),patch.object(d.auto,'ControlFromHandle',return_value=root):
                    self.assertEqual(b.room('Example Group A'),(root,1))
                self.assertGreater(container.children_reads,0)
                for node in (messages,draft,bubble):self.assertEqual(node.children_reads,0)

    def test_explicit_open_only_clicks_the_verified_session_row(self):
        import desktop_bridge as d
        root,target,other,*_=self.navigation();b=object.__new__(Bridge);b.pid=20;b.main=10
        b.targets=[{'id':'group_abao','name':'Example Group A','kind':'group'}];b.check=lambda *_:None;b.read=lambda name:{'group':name}
        with patch.object(d,'windows',return_value=[]),patch.object(d.auto,'ControlFromHandle',return_value=root),patch.object(d,'foreground') as activate:
            self.assertEqual(b.open_room('Example Group A',True),{'group':'Example Group A'})
            activate.assert_called_once_with(10)
        self.assertTrue(target.clicked);self.assertFalse(other.clicked)

    def test_malformed_or_duplicate_configuration_cannot_replace_the_authorized_registry(self):
        import owner_config as owner,json,tempfile
        with tempfile.TemporaryDirectory(dir=owner.ROOT/'temp') as tmp:
            file=pathlib.Path(tmp)/'deployment.local.json'
            valid={'id':'test_group','name':'Example Team','kind':'group'}
            for targets in ({},'Example Team',[valid,valid],[{'id':[],'name':'Group','kind':'group'}],[{'id':'valid','name':'','kind':'group'}]):
                file.write_text(json.dumps({'schemaVersion':1,'account':{},'targets':targets}),encoding='utf-8')
                with patch.object(owner,'CONFIG_PATH',file):
                    with self.assertRaises(ValueError):owner.load_owner_config()

if __name__=='__main__':unittest.main()

