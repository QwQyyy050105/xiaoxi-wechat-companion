"""Short, crash-recoverable WS_EX_NOACTIVATE lease for one verified WeChat HWND.

The guard never reads UI Automation, activates a window, or generates input.
Protocol: one JSON request on stdin, one ready JSON line on stdout, then stop/EOF.
The lease also expires on parent exit and after 30 seconds regardless of input.
"""
from __future__ import annotations
import ctypes as C
from ctypes import wintypes as W
import json
import os
import pathlib
import secrets
import sys
import threading
import time
import psutil

ROOT = pathlib.Path(__file__).resolve().parents[1]
RECEIPT = ROOT / 'data/focus_lease.json'
NOACTIVATE = 0x08000000
COOKIE_NAME = 'Xiaoxi.WeChat.NoActivateLease.v1'
# The transport kills its worker at 20 seconds. The outer 30-second lease gives
# that cancellation time to complete before the fallback style restoration.
LEASE_SECONDS = 30.0


class NativeWindows:
    def __init__(self):
        self.u = C.WinDLL('user32', use_last_error=True)
        self.k = C.WinDLL('kernel32', use_last_error=True)
        self.u.IsWindow.argtypes = [W.HWND]
        self.u.IsWindow.restype = W.BOOL
        self.u.GetWindowThreadProcessId.argtypes = [W.HWND, C.POINTER(W.DWORD)]
        self.u.GetWindowThreadProcessId.restype = W.DWORD
        self.u.GetWindowTextW.argtypes = [W.HWND, W.LPWSTR, C.c_int]
        self.u.GetWindowTextW.restype = C.c_int
        self.u.GetWindowLongPtrW.argtypes = [W.HWND, C.c_int]
        self.u.GetWindowLongPtrW.restype = C.c_ssize_t
        self.u.SetWindowLongPtrW.argtypes = [W.HWND, C.c_int, C.c_ssize_t]
        self.u.SetWindowLongPtrW.restype = C.c_ssize_t
        self.u.SetPropW.argtypes = [W.HWND, W.LPCWSTR, W.HANDLE]
        self.u.SetPropW.restype = W.BOOL
        self.u.GetPropW.argtypes = [W.HWND, W.LPCWSTR]
        self.u.GetPropW.restype = W.HANDLE
        self.u.RemovePropW.argtypes = [W.HWND, W.LPCWSTR]
        self.u.RemovePropW.restype = W.HANDLE
        self.k.CreateMutexW.argtypes = [C.c_void_p, W.BOOL, W.LPCWSTR]
        self.k.CreateMutexW.restype = W.HANDLE
        self.k.CloseHandle.argtypes = [W.HANDLE]
        self.k.CloseHandle.restype = W.BOOL

    def mutex(self):
        C.set_last_error(0)
        handle = self.k.CreateMutexW(None, False, 'Local\\XiaoxiWeChatFocusLease')
        error = C.get_last_error()
        if not handle:
            raise C.WinError(error)
        if error == 183:
            self.k.CloseHandle(handle)
            raise RuntimeError('已有后台发送保护正在运行，请稍后重试')
        return handle

    def process_matches(self, pid, created):
        try:
            p = psutil.Process(pid)
            return p.is_running() and p.name().lower() == 'weixin.exe' and abs(p.create_time() - created) < .001
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return False

    def owner(self, hwnd):
        if not self.u.IsWindow(hwnd):
            return None
        pid = W.DWORD()
        if not self.u.GetWindowThreadProcessId(hwnd, C.byref(pid)):
            return None
        return pid.value

    def title(self, hwnd):
        value = C.create_unicode_buffer(512)
        self.u.GetWindowTextW(hwnd, value, len(value))
        return value.value

    def style(self, hwnd):
        C.set_last_error(0)
        value = self.u.GetWindowLongPtrW(hwnd, -20)
        error = C.get_last_error()
        if not value and error:
            raise C.WinError(error)
        return value & 0xffffffff

    def set_style(self, hwnd, value):
        C.set_last_error(0)
        result = self.u.SetWindowLongPtrW(hwnd, -20, value & 0xffffffff)
        error = C.get_last_error()
        if not result and error:
            raise C.WinError(error)

    def cookie(self, hwnd):
        return int(self.u.GetPropW(hwnd, COOKIE_NAME) or 0)

    def set_cookie(self, hwnd, value):
        if not self.u.SetPropW(hwnd, COOKIE_NAME, value):
            raise C.WinError(C.get_last_error())

    def remove_cookie(self, hwnd, expected):
        if self.cookie(hwnd) != expected:
            raise RuntimeError('窗口保护标记发生变化，未移除其他标记')
        if int(self.u.RemovePropW(hwnd, COOKIE_NAME) or 0) != expected:
            raise RuntimeError('窗口保护标记移除未确认')


def durable_save(path, record):
    temp = path.with_suffix('.new')
    with temp.open('w', encoding='utf-8', newline='\n') as stream:
        json.dump(record, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


class FocusLease:
    def __init__(self, windows, receipt=RECEIPT):
        self.windows = windows
        self.receipt = pathlib.Path(receipt)
        self.record = None

    def _same_window(self, record):
        return (self.windows.process_matches(record['pid'], record['created'])
                and self.windows.owner(record['hwnd']) == record['pid'])

    def _restore(self, record, reason):
        """Never restore a saved whole style or mutate a reused HWND."""
        if not self._same_window(record):
            record.update(active=False, restored=False, released=True,
                          releaseReason='process_or_window_replaced')
        elif self.windows.cookie(record['hwnd']) != record['cookie']:
            record.update(active=False, restored=False, released=True,
                          releaseReason='window_cookie_changed')
        else:
            hwnd = record['hwnd']
            current = self.windows.style(hwnd)
            desired = (current | NOACTIVATE) if record['originalNoActivate'] else (current & ~NOACTIVATE)
            # Unrelated style changes made during the lease are retained.
            if desired != current:
                self.windows.set_style(hwnd, desired)
            if bool(self.windows.style(hwnd) & NOACTIVATE) != record['originalNoActivate']:
                raise RuntimeError('后台窗口属性恢复未确认')
            self.windows.remove_cookie(hwnd, record['cookie'])
            record.update(active=False, restored=True, released=True, releaseReason=reason)
        record['releasedAt'] = time.time()
        durable_save(self.receipt, record)
        return record['restored']

    def acquire(self, request):
        pid, created, hwnd = int(request['pid']), float(request['created']), int(request['hwnd'])
        title = request['title']
        if pid <= 0 or hwnd <= 0 or not isinstance(title, str) or not 1 <= len(title) <= 100:
            raise RuntimeError('后台窗口保护参数无效')
        if not self.windows.process_matches(pid, created) or self.windows.owner(hwnd) != pid:
            raise RuntimeError('后台窗口所属微信进程已变化')
        if self.windows.title(hwnd) != title:
            raise RuntimeError('后台窗口标题不匹配')
        recovery = None
        if self.receipt.exists():
            prior = json.loads(self.receipt.read_text(encoding='utf-8'))
            if not prior.get('released', False):
                self._restore(prior, 'recovered_after_guard_exit')
                recovery = {key: prior.get(key) for key in
                            ('pid', 'created', 'hwnd', 'restored', 'releaseReason', 'releasedAt')}
        # Recovery can take time; validate again before establishing a new lease.
        if not self.windows.process_matches(pid, created) or self.windows.owner(hwnd) != pid or self.windows.title(hwnd) != title:
            raise RuntimeError('后台窗口身份在保护前发生变化')
        if self.windows.cookie(hwnd):
            raise RuntimeError('目标窗口已有未知保护标记，已停止')
        cookie = secrets.randbits(63) or 1
        self.record = dict(version=1, pid=pid, created=created, hwnd=hwnd, title=title,
                           cookie=cookie, originalNoActivate=bool(self.windows.style(hwnd) & NOACTIVATE),
                           active=False, released=False, restored=False, startedAt=time.time())
        if recovery:
            self.record['priorRecovery'] = recovery
        # Persist recovery intent before the first window mutation (SetProp).
        durable_save(self.receipt, self.record)
        self.windows.set_cookie(hwnd, cookie)
        if not self._same_window(self.record) or self.windows.cookie(hwnd) != cookie:
            raise RuntimeError('窗口身份在保护设置时发生变化')
        self.windows.set_style(hwnd, self.windows.style(hwnd) | NOACTIVATE)
        if not self.windows.style(hwnd) & NOACTIVATE:
            raise RuntimeError('后台窗口保护未生效')
        self.record['active'] = True
        durable_save(self.receipt, self.record)
        return dict(ready=True, pid=pid, hwnd=hwnd, expiresInSeconds=LEASE_SECONDS)

    def release(self, reason='stopped'):
        if self.record is None or self.record.get('released'):
            return bool(self.record and self.record.get('restored'))
        try:
            return self._restore(self.record, reason)
        except Exception as error:
            self.record.update(active=False, restored=False, released=False,
                               releaseReason='restore_failed', restoreError=str(error))
            durable_save(self.receipt, self.record)
            return False


def main():
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    windows = NativeWindows()
    mutex = windows.mutex()
    lease = FocusLease(windows)
    reason = 'startup_failed'
    ready_sent = False
    try:
        request = json.loads(sys.stdin.readline())
        parent = psutil.Process(int(request['parent']))
        parent_created = parent.create_time()
        if not parent.is_running():
            raise RuntimeError('发送进程已退出')
        started = time.monotonic()
        ready = lease.acquire(request)
        stopped = threading.Event()

        def reader():
            for line in sys.stdin:
                if line.strip() == 'stop':
                    break
            stopped.set()

        threading.Thread(target=reader, daemon=True).start()
        print(json.dumps(ready), flush=True)
        ready_sent = True
        reason = 'stop_or_eof'
        while not stopped.wait(.1):
            if time.monotonic() - started >= LEASE_SECONDS:
                reason = 'lease_timeout'
                break
            try:
                if not parent.is_running() or parent.create_time() != parent_created:
                    reason = 'parent_exited'
                    break
            except psutil.NoSuchProcess:
                reason = 'parent_exited'
                break
            if not windows.process_matches(lease.record['pid'], lease.record['created']):
                reason = 'wechat_exited'
                break
    finally:
        restored = lease.release(reason)
        windows.k.CloseHandle(mutex)
        if ready_sent:
            print(json.dumps(dict(stopped=True, restored=restored, reason=reason)), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps(dict(error=str(error)), ensure_ascii=False), flush=True)
        sys.exit(1)
