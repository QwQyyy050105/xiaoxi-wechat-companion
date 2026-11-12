"""Open one previously bound standalone chat via the account's own session row."""
import ctypes as C
from ctypes import wintypes as W
import json
import threading
import time

USER = C.WinDLL('user32', use_last_error=True)
USER.GetWindowThreadProcessId.argtypes = (W.HWND, C.POINTER(W.DWORD))
USER.GetAncestor.argtypes = (W.HWND, W.UINT)
USER.GetAncestor.restype = W.HWND
USER.GetWindow.argtypes = (W.HWND, W.UINT)
USER.GetWindow.restype = W.HWND
USER.GetParent.argtypes = (W.HWND,)
USER.GetParent.restype = W.HWND
USER.FindWindowExW.argtypes = (W.HWND, W.HWND, W.LPCWSTR, W.LPCWSTR)
USER.FindWindowExW.restype = W.HWND
USER.IsIconic.argtypes = (W.HWND,)
USER.ShowWindow.argtypes = (W.HWND, C.c_int)
USER.GetWindowTextW.argtypes = (W.HWND, W.LPWSTR, C.c_int)
USER.GetWindowLongPtrW.argtypes = (W.HWND, C.c_int)
USER.GetWindowLongPtrW.restype = C.c_ssize_t
CALLBACK = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
USER.EnumWindows.argtypes = [CALLBACK, W.LPARAM]


def standalone(hwnd, pid):
    actual = W.DWORD()
    return (hwnd and USER.GetWindowThreadProcessId(hwnd, C.byref(actual))
            and actual.value == pid and USER.GetAncestor(hwnd, 2) == hwnd
            and USER.GetAncestor(hwnd, 3) == hwnd and not USER.GetParent(hwnd)
            and not USER.GetWindow(hwnd, 4))


def owned_windows(pid):
    handles = set()
    def visit(hwnd, _):
        actual = W.DWORD()
        if USER.GetWindowThreadProcessId(hwnd, C.byref(actual)) and actual.value == pid:
            handles.add(hwnd)
        return True
    if not USER.EnumWindows(CALLBACK(visit), 0):
        raise RuntimeError('无法核对窗口创建前的账号窗口列表')
    return handles


def matching_windows(pid, name):
    matches = set()
    hwnd = 0
    while True:
        hwnd = USER.FindWindowExW(0, hwnd, None, name)
        if not hwnd: return matches
        actual = W.DWORD()
        if USER.GetWindowThreadProcessId(hwnd, C.byref(actual)) and actual.value == pid:
            matches.add(hwnd)


def title(hwnd):
    value = C.create_unicode_buffer(260)
    USER.GetWindowTextW(hwnd, value, len(value))
    return value.value


# Window measurements are in physical pixels only for per-monitor-aware callers.
USER.GetWindowDpiAwarenessContext.argtypes = (W.HWND,)
USER.GetWindowDpiAwarenessContext.restype = W.HANDLE
USER.GetThreadDpiAwarenessContext.restype = W.HANDLE
USER.GetAwarenessFromDpiAwarenessContext.argtypes = (W.HANDLE,)
USER.GetDpiForWindow.argtypes = (W.HWND,)
USER.GetClassLongPtrW.argtypes = (W.HWND, C.c_int)
USER.GetClassLongPtrW.restype = C.c_size_t
USER.PostMessageW.argtypes = (W.HWND, W.UINT, W.WPARAM, W.LPARAM)

class WaitForIdle(RuntimeError):
    """No window event has been posted; a later idle poll may try again."""

IDLE_REQUIRED_MS = 60_000
TICK_COUNT = C.WinDLL('kernel32', use_last_error=True).GetTickCount
TICK_COUNT.restype = W.DWORD

def require_idle(state, account_pid=None):
    if account_pid is not None and (not state.get('foreground') or state.get('foregroundPid')==account_pid):
        raise WaitForIdle('等待切离微信并使用普通桌面后恢复群窗口')
    tick = state.get('lastInputTick')
    if not isinstance(tick, int) or tick == 0:
        raise WaitForIdle('无法读取系统空闲时间，窗口恢复暂缓')
    elapsed = (TICK_COUNT() - tick) & 0xffffffff
    if elapsed < IDLE_REQUIRED_MS or elapsed >= 0x80000000:
        raise WaitForIdle('等待电脑空闲满 60 秒再恢复群窗口')

class Placement(C.Structure):
    _fields_ = [('length',W.UINT),('flags',W.UINT),('showCmd',W.UINT),
                ('ptMinPosition',W.POINT),('ptMaxPosition',W.POINT),('rcNormalPosition',W.RECT)]

def bounds(obj):
    r=obj.BoundingRectangle
    return r.left,r.top,r.right,r.bottom

def row_point(root, row, name):
    hwnd=root.NativeWindowHandle
    if (row.AutomationId!='session_item_'+name or row.ControlTypeName!='ListItemControl'
            or row.ClassName!='mmui::ChatSessionCell' or row.IsOffscreen or not row.IsEnabled
            or not row.GetPropertyValue(30090) or row.GetLegacyIAccessiblePattern().DefaultAction!='双击'):
        raise RuntimeError('授权会话行不可见或默认动作不符')
    lst=row.GetParentControl()
    if lst.ControlTypeName!='ListControl' or 'XTableView' not in lst.ClassName or lst.IsOffscreen:
        raise RuntimeError('授权行未处于已核对的会话列表')
    if not USER.IsIconic(hwnd) or USER.GetAwarenessFromDpiAwarenessContext(USER.GetWindowDpiAwarenessContext(hwnd))!=2 or USER.GetAwarenessFromDpiAwarenessContext(USER.GetThreadDpiAwarenessContext())!=2:
        raise RuntimeError('主窗口未最小化或无法核对 DPI 坐标')
    placement=Placement();placement.length=C.sizeof(placement)
    dpi=USER.GetDpiForWindow(hwnd)
    if not USER.GetWindowPlacement(hwnd,C.byref(placement)) or not 96<=dpi<=480 or not USER.GetClassLongPtrW(hwnd,-26)&8:
        raise RuntimeError('未取得窗口还原尺寸或双击能力')
    x1,y1,x2,y2=bounds(root); a,b,c,d=bounds(lst); l,t,r,e=bounds(row)
    normal=placement.rcNormalPosition
    if (not 500<=x2-x1<=16000 or not 300<=y2-y1<=16000 or
            not 0<=normal.right-normal.left-(x2-x1)<=48*dpi/96 or
            not 0<=normal.bottom-normal.top-(y2-y1)<=48*dpi/96 or
            not x1<=a<=l<r<=c<=x2 or not y1<=b<=t<e<=d<=y2 or e-t<12 or r-l<40):
        raise RuntimeError('授权行存在裁切或主窗与列表几何不一致')
    return (((l+r)//2-x1)|(((t+e)//2-y1)<<16),dpi,(x1,y1,x2,y2),(a,b,c,d),(l,t,r,e))

def post_row(hwnd,point):
    # Win32 double-click sequence. Private target queue only; no global mouse.
    for message,buttons in ((0x0201,1),(0x0202,0),(0x0203,1),(0x0202,0)):
        if not USER.PostMessageW(hwnd,message,buttons,point):
            raise RuntimeError('定向双击序列未全部受理，未重试')

def write_receipt(file,receipt):
    # A crash after the first event must not lead to a second launch attempt.
    import os
    import tempfile
    fd, name=tempfile.mkstemp(dir=file.parent,prefix=file.stem+'.',suffix='.tmp')
    try:
        with os.fdopen(fd,'w',encoding='utf8') as stream:
            json.dump(receipt,stream);stream.flush();os.fsync(stream.fileno())
        os.replace(name,file)
    finally:
        try:os.unlink(name)
        except FileNotFoundError:pass

def attempted(file,receipt):
    if not file.exists():return False
    prior=json.loads(file.read_text(encoding='utf8'))
    same=all(prior.get(k)==receipt[k] for k in ('pid','created','targetId','method'))
    return same and prior.get('invoked') and not (prior.get('windowVerified') and prior.get('minimized'))

def restore_group(bridge, target, binding, control, row_for, focus, desktop_ready, receipt_file):
    name, main, pid = target['name'], bridge.main, bridge.pid
    receipt = {'pid':pid,'created':bridge.created,'targetId':target['id'],'method':'window_row_double_click',
               'invoked':False,'windowVerified':False,'minimized':False,'focusChanged':False}
    if attempted(receipt_file,receipt):
        raise RuntimeError('同一微信进程已尝试恢复此群，未重复触发')
    halt = threading.Event()
    watcher = None
    before_submit_tick = None
    queue_started = False
    touched, user_input = set(), threading.Event()
    def observe_state():
        state=focus()
        if not state['foreground']:
            user_input.set()
        elif state['foregroundPid']==pid:
            touched.add(state['foreground'])
            if before_submit_tick is None or state.get('lastInputTick')!=before_submit_tick:user_input.set()
        return state
    def observe():
        while not halt.wait(.01):observe_state()
    def stable(allow_new=None):
        observe_state()
        if user_input.is_set() or any(window!=allow_new for window in tuple(touched)):
            if not queue_started:
                raise WaitForIdle('用户正在使用微信，稍后再检查群窗口')
            raise RuntimeError('微信成为前台或用户正在操作，停止恢复')
    def require_desktop():
        try:desktop_ready()
        except RuntimeError as error:raise WaitForIdle(str(error)) from error
    try:
        require_idle(focus(),pid)
        require_desktop()
        bridge.check(True)
        if not binding or not binding.startswith('ChatSingleWindow') or not standalone(main, pid):
            raise RuntimeError('后台恢复需要已绑定的群标识和独立微信主窗口')
        stable()
        watcher = threading.Thread(target=observe, daemon=True)
        watcher.start()
        root = control(main)
        if root.NativeWindowHandle!=main or root.ClassName!='mmui::MainWindow' or root.ControlTypeName!='WindowControl':
            raise RuntimeError('微信主窗控件身份不匹配')
        main_title=title(main)
        if main_title not in ('微信','Weixin','WeChat'):raise RuntimeError('无法核对独立主窗标题')
        with bridge.focus_lease(main_title,main) as guard:
            if attempted(receipt_file,receipt):raise RuntimeError('已有同代恢复记录')
            before=owned_windows(pid)
            if matching_windows(pid,name):raise RuntimeError('群窗已由其他操作打开')
            def ready(allow_new=None):
                stable(allow_new)
                if guard.poll() is not None or not USER.GetWindowLongPtrW(main,-20)&0x08000000:
                    raise RuntimeError('主窗后台保护已结束')
            first=row_point(root,row_for(root,name),name)
            bridge.check(True)
            require_desktop()
            ready()
            second=row_point(root,row_for(root,name),name)
            if first!=second or matching_windows(pid,name):raise RuntimeError('会话行移动或群窗已打开，停止恢复')
            ready()
            before_submit_tick=observe_state().get('lastInputTick')
            require_idle({'lastInputTick':before_submit_tick})
            # Guard against both partial delivery and a worker crash during the sequence.
            receipt.update(invoked=True,at=time.time())
            write_receipt(receipt_file,receipt)
            latest=observe_state()
            if latest.get('lastInputTick') != before_submit_tick:
                raise WaitForIdle('新的用户输入已取消本次投递，等待再次空闲')
            ready()
            queue_started=True
            post_row(main,first[0])
            deadline=time.monotonic()+3
            while time.monotonic()<deadline:
                hits=matching_windows(pid,name)-before
                if len(hits)>1:raise RuntimeError('出现多个同名窗口，停止恢复')
                candidate=next(iter(hits),None)
                # A new Qt HWND can receive focus before its title is populated.
                # Observe only until its identity can be resolved.
                if candidate or not touched or touched.intersection(before):ready(candidate)
                elif user_input.is_set():raise RuntimeError('用户正在操作新窗口，停止恢复')
                if candidate:break
                halt.wait(.04)
            else:raise RuntimeError('微信未创建独立群窗，未追加点击')
            resolved,hwnd=bridge.room(name)
            if (hwnd!=candidate or resolved.AutomationId!=binding or resolved.NativeWindowHandle!=hwnd
                    or resolved.ClassName!='mmui::ChatSingleWindow' or not standalone(hwnd,pid)):
                raise RuntimeError('新窗口与已绑定群不符，未更改显示状态')
            receipt['windowVerified']=True
            bridge.check(True)
            ready(candidate)
            if not USER.IsIconic(hwnd):USER.ShowWindow(hwnd,7)
            ready(candidate)
            if not USER.IsIconic(hwnd):raise RuntimeError('新建群窗最小化未确认')
            receipt['minimized']=True
    finally:
        halt.set()
        if watcher:watcher.join(timeout=.25)
        receipt.update(focusChanged=bool(touched),at=time.time())
        if receipt['invoked']:
            # On a normal pre-submit abort, clear our write-ahead marker.
            # A process crash conservatively leaves it claimed.
            receipt['invoked']=queue_started
            write_receipt(receipt_file,receipt)
        elif not attempted(receipt_file,receipt):
            write_receipt(receipt_file,receipt)
