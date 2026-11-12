"""Xiaoxi JSON-lines transport. UIA only; never opens or decrypts chat databases."""
from __future__ import annotations
import sys, json, pathlib, time, subprocess, threading, ctypes as C, re, os, hashlib
from contextlib import contextmanager
from ctypes import wintypes as W
import psutil
import uiautomation as auto
from native_draft_recovery import clear_verified_draft
from native_message_tracker import NativeMessageTracker
from native_voice_scope import TEXT_AND_IMAGE_ROWS

ROOT=pathlib.Path(__file__).resolve().parents[1]
from owner_config import CONFIG, AUTHORIZED_GROUPS

def authorized_target(target):
    return isinstance(target,dict) and isinstance(target.get('id'),str) and target.get('kind')=='group' and AUTHORIZED_GROUPS.get(target.get('id'))==target.get('name')

U=C.WinDLL('user32',use_last_error=True)
U.GetWindowThreadProcessId.argtypes=[W.HWND,C.POINTER(W.DWORD)]
U.GetWindowTextW.argtypes=[W.HWND,W.LPWSTR,C.c_int]
U.GetClassNameW.argtypes=[W.HWND,W.LPWSTR,C.c_int]
U.IsWindowVisible.argtypes=[W.HWND]
U.IsIconic.argtypes=[W.HWND]
U.GetWindowRect.argtypes=[W.HWND,C.POINTER(W.RECT)]
class WINDOWPLACEMENT(C.Structure):
    _fields_=[('length',W.UINT),('flags',W.UINT),('showCmd',W.UINT),('ptMinPosition',W.POINT),('ptMaxPosition',W.POINT),('rcNormalPosition',W.RECT)]
U.GetWindowPlacement.argtypes=[W.HWND,C.POINTER(WINDOWPLACEMENT)]
U.GetForegroundWindow.restype=W.HWND
U.GetAncestor.argtypes=[W.HWND,W.UINT];U.GetAncestor.restype=W.HWND
U.GetParent.argtypes=[W.HWND];U.GetParent.restype=W.HWND
U.GetWindow.argtypes=[W.HWND,W.UINT];U.GetWindow.restype=W.HWND
U.GetWindowLongPtrW.argtypes=[W.HWND,C.c_int];U.GetWindowLongPtrW.restype=C.c_ssize_t
U.ShowWindow.argtypes=[W.HWND,C.c_int]
U.SetForegroundWindow.argtypes=[W.HWND]
CALLBACK=C.WINFUNCTYPE(W.BOOL,W.HWND,W.LPARAM)
U.EnumWindows.argtypes=[CALLBACK,W.LPARAM]
U.EnumChildWindows.argtypes=[W.HWND,CALLBACK,W.LPARAM]
U.OpenInputDesktop.argtypes=[W.DWORD,W.BOOL,W.DWORD];U.OpenInputDesktop.restype=W.HANDLE
U.CloseDesktop.argtypes=[W.HANDLE]
U.GetUserObjectInformationW.argtypes=[W.HANDLE,C.c_int,C.c_void_p,W.DWORD,C.POINTER(W.DWORD)]
U.PostMessageW.argtypes=[W.HWND,W.UINT,W.WPARAM,W.LPARAM];U.PostMessageW.restype=W.BOOL
U.GetAsyncKeyState.argtypes=[C.c_int];U.GetAsyncKeyState.restype=C.c_short
class LASTINPUTINFO(C.Structure):
    _fields_=[('cbSize',W.UINT),('dwTime',W.DWORD)]
U.GetLastInputInfo.argtypes=[C.POINTER(LASTINPUTINFO)]

class ViewportPending(RuntimeError):
    """This verified room has unread messages beyond the visible viewport."""


def focus_state():
    hwnd=int(U.GetForegroundWindow() or 0);pid=W.DWORD()
    U.GetWindowThreadProcessId(hwnd,C.byref(pid))
    info=LASTINPUTINFO(C.sizeof(LASTINPUTINFO),0);U.GetLastInputInfo(C.byref(info))
    return dict(foreground=hwnd,foregroundPid=pid.value,lastInputTick=int(info.dwTime))

def modifiers_down():
    return any(U.GetAsyncKeyState(key)&0x8000 for key in (0x10,0x11,0x12,0x5b,0x5c))

class NotPosted(RuntimeError):
    """No input event for this commit was accepted by the target queue."""

def observe_send_echo(before, after, text):
    """Return a local observation or None while a submitted message is pending."""
    identity = ('pid', 'created', 'hwnd', 'windowBinding')
    if any(not before.get(k) or before[k] != after.get(k) for k in identity):
        return dict(status='unknown', ids=[], note='提交后绑定窗口已变化，未重试')
    prior = before['messages']
    rows = after['messages']
    ids = [row['id'] for row in rows]
    mode = after.get('continuity', {}).get('mode')
    if (len(ids) != len(set(ids)) or (prior and mode != 'overlap')
            or (not prior and mode not in ('baseline', 'overlap'))):
        return dict(status='unknown', ids=[], note='消息列表连续性不足，未重试')
    if prior:
        last = prior[-1]['id']
        if last not in ids:
            return dict(status='unknown', ids=[], note='找不到提交前的消息位置，未重试')
        rows = rows[ids.index(last) + 1:]
    old = {row['id'] for row in prior}
    candidates = [row for row in rows if row['id'] not in old and
                  row.get('klass') == 'mmui::ChatTextItemView' and row.get('text') == text and
                  row.get('own') is not False and row.get('role') != 'user']
    if len(candidates) > 1:
        return dict(status='unknown', ids=[], note='出现多个同文气泡，无法唯一关联，未重试')
    if not candidates or after.get('draft') is not False:
        return None
    candidate = candidates[0]
    author = 'self' if candidate.get('own') is True or candidate.get('role') == 'assistant' else 'unavailable'
    return dict(status='local_echo', ids=[candidate['id']], echoAuthor=author,
                echoEvidence='unique_text_and_cleared_draft', note='草稿已清空，本机出现一个新增同文文本气泡')

def standalone_minimized_room(main,hwnd,pid):
    if not main or not hwnd or main==hwnd or not pid or not U.IsIconic(hwnd):return False
    for window in (main,hwnd):
        owner=W.DWORD()
        if (not U.GetWindowThreadProcessId(window,C.byref(owner)) or owner.value!=pid
                or U.GetAncestor(window,2)!=window or U.GetAncestor(window,3)!=window
                or U.GetParent(window) or U.GetWindow(window,4)):return False
    control=auto.ControlFromHandle(main)
    return (control.ClassName=='mmui::MainWindow' and control.ControlTypeName=='WindowControl'
            and control.NativeWindowHandle==main)

def minimized_send_point(hwnd,root,field,button):
    if (root.ClassName!='mmui::ChatSingleWindow' or root.NativeWindowHandle!=hwnd
            or field.AutomationId!='chat_input_field' or field.ControlTypeName!='EditControl'
            or button.ControlTypeName!='ButtonControl' or button.Name!='发送' or not button.IsEnabled):
        raise NotPosted('后台发送控件身份变化，未提交')
    placement=WINDOWPLACEMENT();placement.length=C.sizeof(placement)
    if not U.IsIconic(hwnd) or not U.GetWindowPlacement(hwnd,C.byref(placement)):
        raise NotPosted('无法核对最小化群窗口尺寸，未提交')
    left,top,right,bottom=rect(root);width=right-left;height=bottom-top
    normal=placement.rcNormalPosition
    if (not 600<=width<=16000 or not 350<=height<=16000 or
            not 0<=normal.right-normal.left-width<=64 or not 0<=normal.bottom-normal.top-height<=64):
        raise NotPosted('最小化群窗口布局与还原尺寸不一致，未提交')
    ex,ey,er,eb=rect(field);bx,by,br,bb=rect(button)
    if not (left<=ex<er<=right and top<=ey<eb<=bottom
            and left<=bx<br<=right and eb<=by<bb<=bottom):
        raise NotPosted('发送按钮未定位在本群编辑区域，未提交')
    return ((bx+br)//2-left)|(((by+bb)//2-top)<<16)

def post_input_pair(hwnd,down,up):
    if not U.PostMessageW(hwnd,*down):raise NotPosted('提交按下事件未受理')
    if not U.PostMessageW(hwnd,*up):raise RuntimeError('提交释放事件未受理，结果待核对')

def post_target_return(hwnd,root,field):
    """Submit through the verified chat HWND without activating its host.

    Qt UIA Invoke and MSAA default action did not submit on the inspected
    build. Mouse messages submitted but activated the multi-account host.
    Return has a verified no-focus local-echo path, provided unread navigation
    has not moved Qt's internal keyboard focus away from the editor.
    """
    if root.ClassName!='mmui::ChatSingleWindow' or root.NativeWindowHandle!=hwnd:
        raise NotPosted('发送窗口身份变化，未提交')
    if field.AutomationId!='chat_input_field' or field.ControlTypeName!='EditControl':
        raise NotPosted('输入框身份变化，未提交')
    post_input_pair(hwnd,(0x0100,0x0d,0x001C0001),(0x0101,0x0d,0xC01C0001))
    return 'target_hwnd_return'

def desktop_ready():
    handle=U.OpenInputDesktop(0,False,1)
    if not handle:raise RuntimeError('Windows 桌面不可访问，解锁后恢复监听')
    try:
        name=C.create_unicode_buffer(128);needed=W.DWORD()
        if not U.GetUserObjectInformationW(handle,2,name,C.sizeof(name),C.byref(needed)) or name.value.lower()!='default':
            raise RuntimeError('Windows 已锁定或处于安全桌面，解锁后恢复监听')
    finally:U.CloseDesktop(handle)

def windows(selected_pid=None):
    rows=[]; seen=set()
    def visit(hwnd,_):
        if hwnd in seen:return True
        seen.add(hwnd); pid=W.DWORD();U.GetWindowThreadProcessId(hwnd,C.byref(pid))
        if selected_pid is None:
            rows.append({'pid':pid.value})
            return True
        if pid.value!=selected_pid:return True
        title=C.create_unicode_buffer(512); klass=C.create_unicode_buffer(256)
        U.GetWindowTextW(hwnd,title,512);U.GetClassNameW(hwnd,klass,256)
        if klass.value.startswith('Qt'):
            r=W.RECT();U.GetWindowRect(hwnd,C.byref(r))
            if U.IsIconic(hwnd):
                placement=WINDOWPLACEMENT();placement.length=C.sizeof(placement)
                if U.GetWindowPlacement(hwnd,C.byref(placement)):r=placement.rcNormalPosition
            rows.append(dict(hwnd=int(hwnd),pid=pid.value,title=title.value,klass=klass.value,width=r.right-r.left,height=r.bottom-r.top))
        return True
    cb=CALLBACK(visit); U.EnumWindows(cb,0)
    # Multichat may embed WeChat under its own parent window.
    def descendants(hwnd,_):U.EnumChildWindows(hwnd,cb,0);return True
    U.EnumWindows(CALLBACK(descendants),0)
    return rows

def identity_folders(process):
    # Inspect handle path metadata, never file contents. Only account folder names escape this function.
    roots=set()
    for item in process.open_files():
        match=re.search(r'\\xwechat_files\\(wxid_[^\\]+)\\db_storage\\',item.path,re.I)
        if match:roots.add(match.group(1).lower())
    return sorted(roots)

IDENTITY_PERMISSION_NOTE=('微信进程访问权限不足，暂时无法核验Example Account身份；已暂停连接与收发。'
                          '请检查小汐与多开神器/微信的运行权限是否一致后重试。')

def walk(root,limit=1600):
    stack=[root];n=0
    while stack:
        control=stack.pop();n+=1
        if n>limit:raise RuntimeError('控件数量异常，已停止操作')
        yield control
        stack.extend(reversed(control.GetChildren()))

def chat_content_id(automation_id):
    """Content boundaries verified for the supported WeChat UIA layout."""
    return (automation_id in ('chat_message_list','chat_input_field') or
            automation_id.endswith('.chat_bubble_item_view'))

def content_branch(automation_id,klass):
    """Conservative main-window navigation boundary; not a target-title filter."""
    return chat_content_id(automation_id) or bool(re.search(r'(?:ChatMessage|MessageList|ChatInput|ChatBubble|WebView|WebEngine)',klass,re.I))

def walk_chrome(root,limit=400):
    """Metadata only within an already PID/title/class/peer-bound target window.

    Qt can expose a shared title/content container as ChatMessage* or even a
    TextControl. Those labels alone are not content boundaries. Prune only the
    verified content IDs, and never read control Names while finding the title.
    """
    stack=[root];count=0
    while stack:
        control=stack.pop();count+=1
        if count>limit:raise RuntimeError('窗口身份控件数量异常，已停止操作')
        automation_id=control.AutomationId or ''
        yield control
        if chat_content_id(automation_id) or automation_id.startswith('session_item_'):continue
        stack.extend(reversed(control.GetChildren()))

def unique_in(controls,predicate,label):
    matches=[control for control in controls if predicate(control)]
    if len(matches)!=1:raise RuntimeError(label+'不唯一或不可访问')
    return matches[0]

def walk_notices(root,limit=1600):
    """Visit transient overlays without descending into bubbles or the editor.

    The message-list container remains traversable because Qt places unread
    buttons there. This view is rebuilt for every read; no stale UIA objects,
    message content or identities are cached across polls or refresh actions.
    """
    stack=[root];count=0
    while stack:
        control=stack.pop();count+=1
        if count>limit:raise RuntimeError('控件数量异常，已停止操作')
        aid=control.AutomationId or ''
        if aid=='chat_input_field' or aid.endswith('.chat_bubble_item_view') or aid.startswith('session_item_'):continue
        yield control
        stack.extend(reversed(control.GetChildren()))

def message_bubbles(root,limit=1600):
    """Enumerate message rows without expanding their rendered contents.

    Bubble.Name is the native receiver's text/transcript contract. Embedded
    quote/media controls are not additional messages; diagnostic reads expand
    them separately. Rebuild the row list each time to observe delayed updates.
    """
    stack=[root];count=0
    while stack:
        control=stack.pop();count+=1
        if count>limit:raise RuntimeError('消息列表控件数量异常，已停止读取')
        aid=control.AutomationId or ''
        if aid.endswith('.chat_bubble_item_view'):
            yield control
            continue
        if aid=='chat_input_field' or aid.startswith('session_item_'):continue
        stack.extend(reversed(control.GetChildren()))

def authorized_session_item(root,name,limit=400):
    """Find one approved navigation row without reading any row Name/preview.

    Only structural containers are explored outside a recognizable session list.
    Other lists and content/editor branches are leaves. Unknown layouts fail;
    there is no full-tree fallback that could inspect an unrelated open chat.
    """
    if name not in AUTHORIZED_GROUPS.values():raise RuntimeError('隐私范围仅限本机配置的授权群，未读取该会话')
    expected='session_item_'+name;matches=[];stack=[(root,False)];count=0
    structural={'WindowControl','PaneControl','GroupControl','CustomControl','TabControl'}
    while stack:
        control,in_sessions=stack.pop();count+=1
        if count>limit:raise RuntimeError('会话导航控件数量异常，请手动打开已授权群的独立窗口')
        automation_id=control.AutomationId or '';klass=control.ClassName or ''
        if automation_id.startswith('session_item_'):
            if in_sessions and automation_id==expected:matches.append(control)
            continue  # Even an authorized row's preview children are unnecessary.
        if content_branch(automation_id,klass):continue
        role=control.ControlTypeName
        # A mixed/unknown label must not turn another surface into a session list.
        if re.search(r'(?:Contact|AddressBook|SearchResult|HistoryList|Profile|Settings|Browser)',automation_id+' '+klass,re.I):continue
        if role not in structural and role!='ListControl':continue
        session_list=bool(re.search(r'session[_\W]*(?:list|view|panel)|sessionlist',automation_id+' '+klass,re.I))
        if session_list:
            in_sessions=True
        elif role=='ListControl':
            continue
        stack.extend((child,in_sessions) for child in reversed(control.GetChildren()))
    if len(matches)!=1:raise RuntimeError('已授权群的会话入口不唯一或导航结构未验证，请手动打开该群独立窗口')
    return matches[0]

def rect(control):
    r=control.BoundingRectangle
    return [r.left,r.top,r.right,r.bottom]

def foreground(hwnd):
    U.ShowWindow(hwnd,9);U.SetForegroundWindow(hwnd);time.sleep(.15)
    if U.GetForegroundWindow()!=U.GetAncestor(hwnd,2):raise RuntimeError('请展开Example Account的目标微信窗口后重试；未发送键鼠输入')

class Bridge:
    def __init__(self):
        if CONFIG.get('native',{}).get('enabled') is not True:raise RuntimeError('native_wechat_unsupported_or_disabled')
        self.config={'account':{'binding':{'account_folder':CONFIG['account']['folder']}},'allowed_groups':list(AUTHORIZED_GROUPS.values())}
        self.guard=None; self.pid=None; self.created=None;self.main=None;self.rooms={};self.last_identity=0
        self.closed=threading.Event();self.return_focus_uncertain={}
        self.pending_restores={}
        self.restore_targets=frozenset(CONFIG['native'].get('backgroundRestoreTargetIds', []))
        configured=self.config['allowed_groups']
        if not isinstance(configured,list) or not 1<=len(configured)<=64 or any(not isinstance(name,str) or name not in AUTHORIZED_GROUPS.values() for name in configured) or len(set(configured))!=len(configured):raise RuntimeError('隐私范围仅限本机配置的授权群')
        self.targets=[dict(id=next(key for key,value in AUTHORIZED_GROUPS.items() if value==name),name=name,kind='group') for name in configured]
        self.voice_targets = frozenset(CONFIG['native'].get('voiceTargetIds', AUTHORIZED_GROUPS))

    def target(self,name):
        if name not in AUTHORIZED_GROUPS.values():raise RuntimeError('隐私范围仅限本机配置的授权群，未读取该会话')
        found=[x for x in self.targets if x['name']==name]
        if len(found)!=1:raise RuntimeError('目标会话未配置或重名')
        if not authorized_target(found[0]):raise RuntimeError('会话身份不在已授权范围')
        return found[0]

    def _load_return_focus_state(self,wins):
        """Notice a previous jump in this exact process/window, metadata only."""
        self.return_focus_uncertain={}
        tick=focus_state()['lastInputTick']
        for target in self.targets:
            matching=[row for row in wins if row['pid']==self.pid and row['title']==target['name']]
            if len(matching)!=1:continue
            path=ROOT/'data'/('unread_refresh_'+target['id']+'.json')
            try:receipt=json.loads(path.read_text(encoding='utf-8'))
            except FileNotFoundError:continue
            except (OSError,ValueError,TypeError) as error:
                raise RuntimeError('本群旧版后台跳转记录不可读取，已暂停连接') from error
            if not isinstance(receipt,dict):raise RuntimeError('本群旧版后台跳转记录格式异常，已暂停连接')
            if (receipt.get('pid')==self.pid and receipt.get('hwnd')==matching[0]['hwnd'] and
                    isinstance(receipt.get('at'),(int,float)) and receipt['at']>=self.created and
                    receipt.get('focusUnchanged') is False):
                self.return_focus_uncertain[target['name']]={'pid':self.pid,'created':self.created,
                    'hwnd':matching[0]['hwnd'],'lastInputTick':tick}

    def _return_focus_is_uncertain(self,name,hwnd):
        entry=getattr(self,'return_focus_uncertain',{}).get(name)
        return bool(entry and entry.get('pid')==getattr(self,'pid',None) and
                    abs(entry.get('created',0)-getattr(self,'created',0))<.001 and entry.get('hwnd')==hwnd)

    def _clear_return_focus_on_owner_input(self,name,hwnd,field):
        if not self._return_focus_is_uncertain(name,hwnd):return
        self.check()  # Revalidate the bound process and creation time on recovery.
        entry=self.return_focus_uncertain[name]
        try:
            state=focus_state();previous=entry.get('lastInputTick');current=state['lastInputTick']
            # A bot-posted unread click does not advance Windows' physical input
            # timestamp. Require a later human input even when Qt reports focus.
            if not isinstance(previous,int) or not isinstance(current,int):return
            if not 0<((current-previous)&0xffffffff)<0x80000000:return
            group_pid=W.DWORD()
            if not U.GetWindowThreadProcessId(hwnd,C.byref(group_pid)) or group_pid.value!=self.pid:return
            if state['foreground']==hwnd:
                if state['foregroundPid']!=self.pid:return
            else:
                # The carrier embeds the account's verified main window in a
                # vendor host. Accept that host only through the current bound
                # main HWND's parent chain; an arbitrary foreground is rejected.
                main=getattr(self,'main',None)
                if not main or state['foreground']==main:return
                main_pid=W.DWORD()
                if not U.GetWindowThreadProcessId(main,C.byref(main_pid)) or main_pid.value!=self.pid:return
                main_root=auto.ControlFromHandle(main)
                if (main_root.ClassName!='mmui::MainWindow' or
                        main_root.ControlTypeName!='WindowControl' or
                        main_root.NativeWindowHandle!=main):return
                host=int(U.GetAncestor(main,2) or 0)
                if host in (0,main) or state['foreground']!=host:return
                host_pid=W.DWORD()
                if not U.GetWindowThreadProcessId(host,C.byref(host_pid)) or host_pid.value!=state['foregroundPid']:return
            if not field.HasKeyboardFocus:return
        except Exception:return  # A transient UIA failure must retain uncertainty.
        del self.return_focus_uncertain[name]

    def check(self,identity=False):
        try:
            p=psutil.Process(self.pid)
            if p.name().lower()!='weixin.exe' or abs(p.create_time()-self.created)>.001:raise RuntimeError('微信已退出，请重新登录Example Account')
            if not self.guard or self.guard.poll() is not None:raise RuntimeError('兼容接口已停止')
            if identity or time.monotonic()-self.last_identity>10:
                identity_started=time.perf_counter()
                if identity_folders(p)!=[self.config['account']['binding']['account_folder']]:raise RuntimeError('当前微信身份发生变化，已暂停')
                self.last_identity_probe_ms=round((time.perf_counter()-identity_started)*1000,2)
                self.last_identity=time.monotonic()
        except psutil.AccessDenied as error:
            # Unreadable metadata is not evidence of logout or changed identity.
            # Keep the account check mandatory and do not refresh its cache.
            raise RuntimeError(IDENTITY_PERMISSION_NOTE) from error
        except psutil.NoSuchProcess as error:
            raise RuntimeError('微信已退出，请重新登录Example Account') from error

    def connect(self):
        binding=self.config['account'].get('binding')
        if not binding or not binding.get('account_folder'):raise RuntimeError('尚未绑定Example Account的本机身份')
        possible={x['pid'] for x in windows()}
        found=[]; denied=[]
        for pid in possible:
            try:
                p=psutil.Process(pid)
                if p.name().lower()=='weixin.exe' and identity_folders(p)==[binding['account_folder']]:found.append(p)
            except psutil.NoSuchProcess:pass
            except psutil.AccessDenied:denied.append(pid)
        if not found and denied:raise RuntimeError(IDENTITY_PERMISSION_NOTE)
        if len(found)!=1:raise RuntimeError('等待登录Example Account并展开微信主窗口；匹配账号数：'+str(len(found)))
        process=found[0]
        try:created=process.create_time()
        except psutil.AccessDenied as error:raise RuntimeError(IDENTITY_PERMISSION_NOTE) from error
        except psutil.NoSuchProcess as error:raise RuntimeError('微信已退出，请重新登录Example Account') from error
        self.pid=process.pid;self.created=created
        wins=windows(self.pid)
        main=[x for x in wins if x['pid']==self.pid and x['title'] in ('微信','Weixin','WeChat') and x['width']>=600 and x['height']>=350]
        if len(main)!=1:raise RuntimeError('微信主窗口不唯一，请在多开神器中拆分Example Account窗口')
        self.main=main[0]['hwnd']
        self._load_return_focus_state(wins)
        self.guard=subprocess.Popen([sys.executable,'-B',str(ROOT/'scripts/accessibility_guard.py')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8',creationflags=0x08000000,cwd=ROOT)
        self.guard.stdin.write(json.dumps(dict(pid=self.pid,created=self.created,parent=os.getpid()))+'\n');self.guard.stdin.flush()
        ready=json.loads(self.guard.stdout.readline())
        if not ready.get('ready'):raise RuntimeError(ready.get('error','兼容接口未就绪'))
        def heartbeat():
            while not self.closed.wait(3):
                try:self.guard.stdin.write('beat\n');self.guard.stdin.flush()
                except Exception:break
        threading.Thread(target=heartbeat,daemon=True).start()
        self.check(True)
        return dict(pid=self.pid,created=self.created,account=CONFIG['account']['displayName'],version='4.1.15.56')

    def room(self,name,*,chrome_out=None):
        target=self.target(name)
        self.check()
        desktop_ready()
        matches=[x for x in windows(self.pid) if x['pid']==self.pid and x['title']==name]
        if len(matches)!=1:raise RuntimeError('请打开群“'+name+'”的独立窗口（双击会话），找到 '+str(len(matches))+' 个')
        row=matches[0]
        # UI Automation can expose the Qt tree while minimized. Validate the
        # semantic identity below instead of refusing solely on window state.
        root=auto.ControlFromHandle(row['hwnd'])
        if root.ClassName!='mmui::ChatSingleWindow':raise RuntimeError('窗口类型不匹配')
        peer=root.AutomationId
        if not peer.startswith('ChatSingleWindow') or len(peer)<=len('ChatSingleWindow'):raise RuntimeError('缺少稳定会话标识')
        if target.get('windowBinding') and target['windowBinding']!=peer:raise RuntimeError('同名会话身份发生变化，已暂停')
        chrome=list(walk_chrome(root))
        title=unique_in(chrome,lambda x:x.AutomationId.endswith('.current_chat_name_label'),'群标题')
        if title.Name!=name:raise RuntimeError('群标题不匹配')
        # Group kind is verified rather than accepting a same-named private contact.
        is_group=any(x.ClassName=='mmui::ChatTitleBarChatRoomView' for x in chrome)
        if is_group!=(target['kind']=='group'):raise RuntimeError('会话类型不匹配')
        target['windowBinding']=peer
        if chrome_out is not None:chrome_out.extend(chrome)
        return root,row['hwnd']

    def open_room(self,name,allow_foreground=False):
        from native_window_restore import WaitForIdle, restore_group
        target=self.target(name)
        self.check(True)
        if any(row['title']==name for row in windows(self.pid)):
            self.pending_restores.pop(name,None)
            return self.read(name)
        selected=self.restore_targets
        if not allow_foreground or target['id'] not in selected:
            raise RuntimeError('本群尚无独立窗口，请在微信中手动打开该群')
        if not self.main:
            raise RuntimeError('未找到独立微信主窗口，请在微信中手动打开该群')
        try:
            restore_group(self,target,target.get('windowBinding'),auto.ControlFromHandle,authorized_session_item,
                          focus_state,desktop_ready,ROOT/'data'/('background_open_'+target['id']+'.json'))
        except WaitForIdle:
            self.pending_restores[name]=time.monotonic()+15
            raise
        return self.read(name)

    def poll_room(self,name,diagnostic=False):
        pending=self.pending_restores.get(name)
        if pending is None:
            return self.read(name,diagnostic)
        if time.monotonic()<pending:
            raise RuntimeError('等待电脑空闲满 60 秒再检查群窗口')
        # A human may already have opened it. This call reads only the
        # exact target's handle before consulting system idle time.
        from native_window_restore import WaitForIdle, matching_windows, require_idle
        if not matching_windows(self.pid,name):
            try:
                require_idle(focus_state(),self.pid)
            except WaitForIdle:
                self.pending_restores[name]=time.monotonic()+15
                raise
        self.pending_restores.pop(name)
        return self.open_room(name,True)

    def read(self,name,diagnostic=False):
        read_started=time.perf_counter();chrome=[]
        root,hwnd=self.room(name,chrome_out=chrome)
        room_finished=time.perf_counter()
        unread = None
        try:
            advance = self.refresh_unread(name,root,hwnd)
        except ViewportPending as error:
            if not U.IsIconic(hwnd) or diagnostic or not hasattr(self,'message_tracker'):
                raise
            unread = error
            advance = False
        refresh_finished=time.perf_counter()
        if advance:
            chrome=[]
            root,hwnd=self.room(name,chrome_out=chrome)
        messages=unique_in(chrome,lambda x:x.AutomationId=='chat_message_list','消息列表')
        field=unique_in(chrome,lambda x:x.AutomationId=='chat_input_field','输入框')
        self._clear_return_focus_on_owner_input(name,hwnd,field)
        bubbles=list(message_bubbles(messages))
        data=[]
        target_id = self.target(name)['id']
        voice_allowed = target_id in self.voice_targets
        for bubble in bubbles[-100:]:
            klass = bubble.ClassName
            text = (bubble.Name or '') if voice_allowed or klass in TEXT_AND_IMAGE_ROWS else ''
            row=dict(id='.'.join(map(str,bubble.GetRuntimeId())),text=text,klass=klass,rect=rect(bubble))
            # A diagnostic subtree can contain a quoted voice inside a text row.
            if diagnostic and voice_allowed:
                row['help']=bubble.HelpText;row['description']=str(bubble.GetPropertyValue(30159))
                row['children']=[dict(name=x.Name,klass=x.ClassName,id=x.AutomationId,rect=rect(x)) for x in walk(bubble)]
            data.append(row)
        # Operational receipt only: never record text or sender labels here.
        # A successful UIA read does not prove that hidden Qt windows are fresh.
        if not hasattr(self,'read_health'):self.read_health={}
        current=time.monotonic()
        previous=self.read_health.get(target_id,{})
        digest=hashlib.sha256(json.dumps([(row['id'],row['klass'],row['text']) for row in data],ensure_ascii=False).encode()).hexdigest()
        generation = (self.pid,self.created,hwnd,root.AutomationId)
        if (unread and not self.message_tracker.has_visible_append(name,generation,data)
                and not (voice_allowed and self.message_tracker.has_visible_voice_update(name,generation,data))):
            # A send may recheck the exact viewport just accepted by the poller.
            confirmed = previous.get('partialAt')
            if not (getattr(self,'checking_send',False) and digest == previous.get('digest')
                    and confirmed is not None and current-confirmed < 10
                    and self.message_tracker.rooms.get(name,{}).get('generation') == generation):
                raise unread
        # Idle polls only reuse unchanged rows from this bound window. Recheck
        # account ownership before any new/updated payload crosses the native
        # transport boundary; sends still perform their own fresh checks.
        if previous.get('digest')!=digest:self.check(True)
        changed=current if previous.get('digest')!=digest else previous['changed']
        health={'digest':digest,'changed':changed,'saved':previous.get('saved',0)}
        if unread:
            health['partialAt'] = current if previous.get('digest') != digest else previous.get('partialAt')
        if current-health['saved']>3 and not getattr(self,'focus_depth',0):
            health['saved']=current
            scroll={'available':False}
            try:
                pattern=messages.GetScrollPattern()
                if pattern:scroll={'available':True,'verticalScrollable':pattern.VerticallyScrollable,'verticalPercent':pattern.VerticalScrollPercent,'verticalViewSize':pattern.VerticalViewSize}
            except Exception:pass
            notices=[]
            for item in walk_notices(root):
                if item.ControlTypeName=='ButtonControl':
                    label=item.Name or ''
                    kind='new_messages' if re.fullmatch(r'\d+条新消息',label) else 'mention' if label.endswith('提到了你') else None
                    if kind:notices.append({'kind':kind,'invokeAvailable':bool(item.GetPropertyValue(30031)),'legacyAvailable':bool(item.GetPropertyValue(30090))})
            classes={kind:sum(row['klass']==kind for row in data) for kind in {row['klass'] for row in data}}
            receipt={'at':time.time(),'targetId':target_id,'pid':self.pid,'hwnd':hwnd,'windowBinding':root.AutomationId,'rowCount':len(data),'classes':classes,'summonsRows':sum(any(alias in row['text'] for alias in CONFIG.get('character',{}).get('aliases',[])) for row in data),'draftChars':len(field.GetValuePattern().Value or ''),'digest':digest,'stationarySeconds':round(current-changed,1),'minimized':bool(U.IsIconic(hwnd)),'visible':bool(U.IsWindowVisible(hwnd)),'rootHwnd':int(U.GetAncestor(hwnd,2) or 0),'scroll':scroll,'notices':notices}
            receipt['voiceIntakeEnabled'] = voice_allowed
            receipt['timingMs']={'room':round((room_finished-read_started)*1000,2),'refresh':round((refresh_finished-room_finished)*1000,2),'content':round((time.perf_counter()-refresh_finished)*1000,2),'lastIdentityProbe':getattr(self,'last_identity_probe_ms',None)}
            (ROOT/'data'/('read_health_'+target_id+'.json')).write_text(json.dumps(receipt),encoding='utf-8')
        self.read_health[target_id]=health
        if not hasattr(self,'message_tracker'):self.message_tracker=NativeMessageTracker()
        delivered,continuity=self.message_tracker.observe(name,(self.pid,self.created,hwnd,root.AutomationId),data,advance.get('unreadCount',0) if isinstance(advance,dict) else 0)
        if unread:
            continuity['unreadBeyondViewport'] = True
        if digest!=previous.get('digest'):
            receipt={'at':time.time(),'targetId':target_id,'pid':self.pid,'hwnd':hwnd,'digest':digest,**continuity}
            path=ROOT/'data'/('read_transitions_'+target_id+'.json')
            try:history=json.loads(path.read_text(encoding='utf-8'))
            except (OSError,ValueError):history=[]
            path.write_text(json.dumps((history+[receipt])[-30:]),encoding='utf-8')
        return dict(group=name,windowBinding=root.AutomationId,hwnd=hwnd,pid=self.pid,created=self.created,messages=delivered,
                    isMinimized=bool(U.IsIconic(hwnd)),draft=bool(field.GetValuePattern().Value),listRect=rect(messages),continuity=continuity)

    def refresh_unread(self,name,root,hwnd):
        """Refuse to baseline an out-of-viewport message without moving UI.

        The supported Qt build needs a targeted mouse click to jump to unread
        messages, and that click has activated the multi-account host in live
        traces. The owner must make this navigation; ordinary viewport reads
        continue automatically. Raising keeps the message tracker unchanged.
        """
        self.target(name)
        if getattr(self,'focus_depth',0):return False
        for item in walk_notices(root):
            if item.ControlTypeName!='ButtonControl' or not item.IsEnabled:continue
            label=item.Name or ''
            if re.fullmatch(r'\d+条新消息',label) or label.endswith('提到了你'):
                raise ViewportPending('群“'+name+'”停在旧消息：请在微信中手动点未读提示跳到最新，再最小化群窗口；小汐已暂停本群读取，避免漏读或抢前台')
        return False

    def prepare(self,name,text,expected_hwnd=None):
        if not isinstance(text,str) or not text.strip() or len(text)>4000:raise RuntimeError('消息为空或超过4000字')
        self.check(True)
        chrome=[]
        root,hwnd=self.room(name,chrome_out=chrome)
        if expected_hwnd is not None and hwnd!=expected_hwnd:raise RuntimeError('会话窗口已更换，未输入')
        field=unique_in(chrome,lambda x:x.AutomationId=='chat_input_field','输入框')
        value=field.GetValuePattern()
        if value.Value:raise RuntimeError('微信输入框有手动草稿，已暂停发送')
        value.SetValue(text,waitTime=.2)
        if value.Value!=text:raise RuntimeError('输入框内容未确认，未发送')
        return root,field,value,hwnd

    def clear_unknown_draft(self, request):
        name = request['group']
        if request.get('anchorClass') not in ('mmui::ChatTextItemView', 'mmui::ChatVoiceItemView'):
            raise RuntimeError('不支持此类原来信，保留隔离')
        if self.target(name)['id'] != request.get('targetId'):
            raise RuntimeError('未授权的会话标识')
        if request['anchorClass'] == 'mmui::ChatVoiceItemView' and request['targetId'] not in self.voice_targets:
            raise RuntimeError('本群未启用语音读取，保留隔离')
        guard = None
        def verify():
            self.check(True)
            if (self.pid != request['pid'] or self.created != request['created']
                    or focus_state()['foregroundPid'] == self.pid):
                raise RuntimeError('微信账号或使用状态已变化，保留隔离')
            if guard is not None and (guard.poll() is not None or not U.GetWindowLongPtrW(request['hwnd'], -20) & 0x08000000):
                raise RuntimeError('后台焦点保护失效，保留隔离')
        def inspect():
            chrome = []
            root, hwnd = self.room(name, chrome_out=chrome)
            if hwnd != request['hwnd'] or root.AutomationId != request['binding']:
                raise RuntimeError('群窗口身份变化，保留隔离')
            if focus_state()['foregroundPid'] == self.pid:
                raise RuntimeError('正在使用微信，请切回小汐后再核对')
            for notice in walk_notices(root):
                if notice.ControlTypeName == 'ButtonControl' and notice.IsEnabled:
                    label = notice.Name or ''
                    if re.fullmatch(r'\d+条新消息', label) or label.endswith('提到了你'):
                        raise RuntimeError('群窗口有未查看的新消息，保留隔离')
            messages = unique_in(chrome, lambda c: c.AutomationId == 'chat_message_list', '消息列表')
            field = unique_in(chrome, lambda c: c.AutomationId == 'chat_input_field' and c.ControlTypeName == 'EditControl', '输入框')
            rows = []
            seen_anchor = False
            for bubble in message_bubbles(messages):
                native_id = '.'.join(map(str, bubble.GetRuntimeId()))
                kind = bubble.ClassName
                is_anchor = native_id == request['anchorId']
                if is_anchor and kind != request['anchorClass']:
                    raise RuntimeError('原来信的控件类型已变化，保留隔离')
                seen_anchor = seen_anchor or is_anchor
                label = (bubble.Name or '') if is_anchor or (seen_anchor and kind == 'mmui::ChatTextItemView') else ''
                rows.append((native_id, kind, label))
            return rows, field.GetValuePattern()
        verify()
        root, hwnd = self.room(name)
        if hwnd != request['hwnd'] or root.AutomationId != request['binding']:
            raise RuntimeError('群窗口身份变化，保留隔离')
        attempted = False
        def mark_attempt():
            nonlocal attempted
            attempted = True
        try:
            with self.focus_lease(name, hwnd) as guard:
                return clear_verified_draft(request, inspect, verify, mark_attempt)
        except Exception as error:
            if attempted:
                raise RuntimeError('已尝试清理，结果待核对。请检查该群草稿和气泡，确认后点“已核对微信，恢复本群”') from error
            raise

    def probe_input(self,name):
        text='小汐输入框自检（不会发送）'
        root,field,value,hwnd=self.prepare(name,text)
        try:
            buttons=[dict(name=x.Name,id=x.AutomationId,klass=x.ClassName,invoke=bool(x.GetPropertyValue(30031)),enabled=x.IsEnabled) for x in walk_chrome(root) if x.ControlTypeName=='ButtonControl']
            return dict(value_verified=value.Value==text,buttons=buttons)
        finally:
            if value.Value==text:value.SetValue('',waitTime=.1)

    @contextmanager
    def focus_lease(self,name,hwnd):
        guard=subprocess.Popen([sys.executable,'-B',str(ROOT/'scripts/focus_guard.py')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding='utf-8',creationflags=0x08000000,cwd=ROOT)
        try:
            guard.stdin.write(json.dumps(dict(pid=self.pid,created=self.created,parent=os.getpid(),hwnd=hwnd,title=name))+'\n');guard.stdin.flush()
            line=guard.stdout.readline()
            ready=json.loads(line) if line else {}
            if not ready.get('ready'):raise RuntimeError(ready.get('error','后台焦点保护未就绪'))
            self.focus_depth=getattr(self,'focus_depth',0)+1
            try:yield guard
            finally:self.focus_depth-=1
        finally:
            try:
                guard.stdin.write('stop\n');guard.stdin.flush();guard.stdin.close();guard.wait(timeout=3)
                result=json.loads(guard.stdout.readline() or '{}')
                if not result.get('restored'):raise RuntimeError('后台窗口属性恢复未确认，请停止并重新连接')
            except (BrokenPipeError,OSError,subprocess.TimeoutExpired) as error:
                raise RuntimeError('后台窗口保护未正常结束，请停止并重新连接') from error

    def send(self,name,text):
        """Keep a technical receipt, without recording the outgoing text."""
        self.send_trace=[];events=[];halt=threading.Event();start=time.monotonic()
        def monitor():
            previous=None
            while not halt.is_set():
                state=focus_state()
                if state!=previous:events.append(dict(elapsed=round(time.monotonic()-start,3),**state));previous=state
                halt.wait(.01)
        thread=threading.Thread(target=monitor,daemon=True);thread.start()
        self.mark_send('before')
        try:
            result=self._send(name,text)
            self.mark_send('after_release')
            # Observe deferred Qt activation after restoring style; never
            # fight a focus change by switching the user's foreground back.
            time.sleep(.35)
        finally:
            halt.set();thread.join(timeout=1);self.mark_send('settled')
            if 'result' in locals():
                observed = {entry.get('foregroundPid') for entry in events}
                pid = getattr(self, 'pid', None)
                result['wechatForegroundObserved'] = (True if pid and pid in observed else
                    False if pid and observed and all(observed) else None)
            receipt=dict(at=time.time(),group=name,pid=getattr(self,'pid',None),result=locals().get('result'),phases=self.send_trace,focusEvents=events)
            (ROOT/'data/last_native_send.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
        return result

    def mark_send(self,phase):
        if hasattr(self,'send_trace'):self.send_trace.append(dict(phase=phase,at=time.time(),**focus_state()))

    def _send(self,name,text):
        """Bound, non-activating send. No foreground/physical-input fallback."""
        submitted=False;value=None;protected=None
        try:
            self.checking_send = True
            try:
                before = self.read(name)
            finally:
                self.checking_send = False
            hwnd=before['hwnd']
            use_button=standalone_minimized_room(getattr(self,'main',None),hwnd,getattr(self,'pid',None))
            if not use_button and self._return_focus_is_uncertain(name,hwnd):
                return dict(status='deferred',ids=[],note='后台跳转后输入焦点未确认；请在该群输入框点一下，再切回其他软件')
            if before['draft']:return dict(status='deferred',ids=[],note='输入框有手动草稿，待清空后发送')
            if U.GetForegroundWindow()==hwnd or (getattr(self,'pid',None) and focus_state()['foregroundPid']==self.pid):return dict(status='deferred',ids=[],note='正在使用Example Account微信窗口，切换到其他软件后发送')
            if modifiers_down():return dict(status='deferred',ids=[],note='正在使用快捷键，松开后发送')
            with self.focus_lease(name,hwnd) as protected:
                try:
                    self.mark_send('protected')
                    root,field,value,hwnd=self.prepare(name,text,expected_hwnd=hwnd)
                    self.mark_send('prepared')
                    self.check(True)
                    chrome=[]  # Freshly bound controls for this commit only.
                    commit_root,commit_hwnd=self.room(name,chrome_out=chrome)
                    if commit_hwnd!=hwnd:raise RuntimeError('发送前会话窗口已更换')
                    if protected.poll() is not None:raise RuntimeError('后台焦点保护已停止，未发送')
                    if value.Value!=text:raise RuntimeError('发送前草稿变化，未发送')
                    commit_field=unique_in(chrome,lambda x:x.AutomationId=='chat_input_field','输入框')
                    if commit_field.GetValuePattern().Value!=text:raise RuntimeError('发送前草稿变化，未发送')
                    if U.GetForegroundWindow()==hwnd or (getattr(self,'pid',None) and focus_state()['foregroundPid']==self.pid):return dict(status='deferred',ids=[],note='正在使用Example Account微信窗口，切换到其他软件后发送')
                    button=unique_in(chrome,lambda x:x.ControlTypeName=='ButtonControl' and x.Name=='发送','发送按钮')
                    if not button.IsEnabled:raise RuntimeError('发送按钮不可调用')
                    if modifiers_down():return dict(status='deferred',ids=[],note='正在使用快捷键，松开后发送')
                    if use_button:
                        point=minimized_send_point(hwnd,commit_root,commit_field,button)
                        if (not standalone_minimized_room(self.main,hwnd,self.pid)
                                or not U.GetWindowLongPtrW(hwnd,-20)&0x08000000
                                or minimized_send_point(hwnd,commit_root,commit_field,button)!=point
                                or protected.poll() is not None or commit_field.GetValuePattern().Value!=text
                                or focus_state()['foregroundPid']==self.pid or modifiers_down()):
                            raise NotPosted('群窗口、草稿或后台保护已变化，未提交')
                        self.mark_send('standalone_button')
                    try:
                        submitted=True
                        if use_button:
                            post_input_pair(hwnd,(0x0201,1,point),(0x0202,0,point))
                        else:
                            post_target_return(hwnd,commit_root,commit_field)
                    except NotPosted:
                        submitted=False
                        raise
                    self.mark_send('posted')
                    deadline=time.monotonic()+5
                    while time.monotonic()<deadline:
                        after=self.read(name)
                        observation=observe_send_echo(before,after,text)
                        if observation is not None:
                            if observation['status']=='local_echo':self.mark_send('echo')
                            return observation
                        time.sleep(.2)
                    return dict(status='unknown',ids=[],note='后台提交后未确认气泡，不自动重试')
                finally:
                    # Never clear a potentially submitted draft or a user edit.
                    if not submitted and value is not None and protected.poll() is None and value.Value==text:
                        value.SetValue('',waitTime=.1)
                        if value.Value:raise RuntimeError('本次临时草稿未确认清空，本条取消')
        except ViewportPending as error:
            return dict(status='unknown' if submitted else 'deferred',ids=[],note=str(error))
        except Exception as error:
            return dict(status='unknown' if submitted else 'not_sent',ids=[],note=str(error))

    def stop(self):
        self.closed.set()
        if self.guard:
            try:self.guard.stdin.write('stop\n');self.guard.stdin.flush();self.guard.stdin.close();self.guard.wait(timeout=4)
            except Exception:pass
        return {'stopped':True}

    def dispatch(self,request):
        command=request['command']
        if command=='connect':
            supplied=request.get('targets',self.targets)
            if not isinstance(supplied,list) or not 1<=len(supplied)<=64:raise RuntimeError('隐私范围仅限本机配置的授权群')
            if any(not authorized_target(x) for x in supplied):raise RuntimeError('会话不在已授权范围，未连接或读取')
            if len({x['name'] for x in supplied})!=len(supplied):raise RuntimeError('会话显示名重复')
            self.targets=supplied
            return self.connect()
        if command=='open':return self.open_room(request['group'],request.get('allowForeground') is True)
        if command=='health':self.check();return {'healthy':True}
        if command=='read':return self.poll_room(request['group'],request.get('diagnostic',False))
        if command=='clear_unknown_draft':return self.clear_unknown_draft(request)
        if command=='probe_input':return self.probe_input(request['group'])
        if command=='send':return self.send(request['group'],request['text'])
        if command=='stop':return self.stop()
        raise RuntimeError('未知命令')

def main():
    sys.stdout.reconfigure(encoding='utf-8');sys.stdin.reconfigure(encoding='utf-8')
    if '--transport-token' in sys.argv:
        token=sys.argv[sys.argv.index('--transport-token')+1];process=psutil.Process()
        print(json.dumps(dict(event='worker_ready',token=token,pid=os.getpid(),created=process.create_time(),ancestors=[dict(pid=a.pid,created=a.create_time()) for a in process.parents()])),flush=True)
    auto.SetGlobalSearchTimeout(2)
    bridge=Bridge()
    try:
        for line in sys.stdin:
            request={}
            try:
                request=json.loads(line); result=bridge.dispatch(request)
                print(json.dumps(dict(id=request.get('id'),result=result),ensure_ascii=False),flush=True)
            except ViewportPending as error:
                print(json.dumps(dict(id=request.get('id'),error=str(error),code='viewport_pending'),ensure_ascii=False),flush=True)
            except Exception as error:
                print(json.dumps(dict(id=request.get('id'),error=str(error)),ensure_ascii=False),flush=True)
    finally:bridge.stop()

if __name__=='__main__':main()
