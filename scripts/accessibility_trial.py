"""Opt-in, bounded accessibility compatibility test for one bound WeChat process.

Default is inspection only. --perform-temporary-test changes ONE data byte,
checks control structure for up to five seconds, and restores the original byte
in finally. It never scans private process memory, reads databases, injects code,
changes DLL files, sends input/messages, or changes system accessibility flags.
Use only after explicit user approval for the named account/process instance.
"""
from __future__ import annotations
import argparse
import ctypes as C
from ctypes import wintypes as W
import hashlib
import json
import multiprocessing
import pathlib
import time
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
K = C.WinDLL('kernel32',use_last_error=True)
U = C.WinDLL('user32',use_last_error=True)

class Module(C.Structure):
    _fields_=[('size',W.DWORD),('module_id',W.DWORD),('pid',W.DWORD),
              ('global_usage',W.DWORD),('process_usage',W.DWORD),
              ('base',C.c_void_p),('image_size',W.DWORD),('handle',W.HMODULE),
              ('name',W.WCHAR*256),('path',W.WCHAR*260)]

K.CreateToolhelp32Snapshot.argtypes=[W.DWORD,W.DWORD]
K.CreateToolhelp32Snapshot.restype=W.HANDLE
K.Module32FirstW.argtypes=[W.HANDLE,C.POINTER(Module)]
K.Module32NextW.argtypes=[W.HANDLE,C.POINTER(Module)]
K.CloseHandle.argtypes=[W.HANDLE]
K.OpenProcess.argtypes=[W.DWORD,W.BOOL,W.DWORD]
K.OpenProcess.restype=W.HANDLE
K.ReadProcessMemory.argtypes=[W.HANDLE,C.c_void_p,C.c_void_p,C.c_size_t,C.POINTER(C.c_size_t)]
K.WriteProcessMemory.argtypes=K.ReadProcessMemory.argtypes
U.GetWindowThreadProcessId.argtypes=[W.HWND,C.POINTER(W.DWORD)]

def loaded_dll(pid):
    snapshot=K.CreateToolhelp32Snapshot(0x18,pid)
    if snapshot==C.c_void_p(-1).value:
        raise C.WinError(C.get_last_error())
    try:
        entry=Module();entry.size=C.sizeof(Module)
        ok=K.Module32FirstW(snapshot,C.byref(entry))
        while ok:
            if entry.name.lower()=='weixin.dll':
                return pathlib.Path(entry.path),int(entry.base),int(entry.image_size)
            ok=K.Module32NextW(snapshot,C.byref(entry))
    finally:
        K.CloseHandle(snapshot)
    raise RuntimeError('Weixin.dll is not loaded')

def read_byte(handle,address):
    value=C.c_ubyte();count=C.c_size_t()
    if not K.ReadProcessMemory(handle,C.c_void_p(address),C.byref(value),1,C.byref(count)) or count.value!=1:
        raise C.WinError(C.get_last_error())
    return value.value

def write_byte(handle,address,value):
    payload=C.c_ubyte(value);count=C.c_size_t()
    if not K.WriteProcessMemory(handle,C.c_void_p(address),C.byref(payload),1,C.byref(count)) or count.value!=1:
        raise C.WinError(C.get_last_error())
    if read_byte(handle,address)!=value:
        raise RuntimeError('Byte read-back mismatch')

def control_evidence(hwnd,groups):
    import uiautomation as auto
    root=auto.ControlFromHandle(hwnd)
    stack=[(root,0)];count=0;classes=set();found=set();deadline=time.monotonic()+5
    while stack and count<300 and time.monotonic()<deadline:
        control,depth=stack.pop();count+=1
        klass=control.ClassName or '';classes.add(klass)
        # Persist only allowlisted group names; never retain message/member text.
        name=control.Name or ''
        if name in groups: found.add(name)
        if depth<16:
            stack.extend((child,depth+1) for child in control.GetChildren())
    return {'node_count':count,'classes':sorted(classes),'exact_allowlisted_names':sorted(found),
            'mmui_present':any(c.startswith('mmui::') for c in classes),'capped':bool(stack)}

def evidence_worker(connection,hwnd,groups):
    try:connection.send({'result':control_evidence(hwnd,groups)})
    except Exception as error:connection.send({'error':type(error).__name__})
    finally:connection.close()

def bounded_evidence(hwnd,groups):
    context=multiprocessing.get_context('spawn')
    parent,child=context.Pipe(duplex=False)
    worker=context.Process(target=evidence_worker,args=(child,hwnd,groups))
    worker.start();child.close()
    try:
        if not parent.poll(8):raise TimeoutError('Accessibility query timed out')
        response=parent.recv()
        if 'error' in response:raise RuntimeError(response['error'])
        return response['result']
    finally:
        parent.close();worker.join(timeout=0.2)
        if worker.is_alive():worker.terminate();worker.join(timeout=1)

