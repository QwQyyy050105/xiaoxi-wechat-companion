"""Terminate only one transport's token-bound Python worker and redirector.

Guard children have different command lines and are deliberately left alive so
they can restore their leases when the worker's pipes close.
"""
from __future__ import annotations
import json
import pathlib
import re
import sys
import psutil

ROOT = pathlib.Path(__file__).resolve().parents[1]


def matching_process(pid, script, token, created=None):
    try:
        process = psutil.Process(int(pid))
        if process.name().lower() not in ('python.exe', 'pythonw.exe'):
            return None
        if created is not None and abs(process.create_time() - float(created)) > .001:
            return None
        args = process.cmdline()
        if '--transport-token' not in args:
            return None
        index = args.index('--transport-token')
        if index + 1 >= len(args) or args[index + 1] != token:
            return None
        if not any(pathlib.Path(arg).is_absolute() and pathlib.Path(arg).resolve() == script for arg in args):
            return None
        return process
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError, ValueError):
        return None


def terminate(request):
    token = request['token']
    if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9-]{36}', token):
        raise RuntimeError('Invalid owned transport token')
    script = pathlib.Path(request['scriptPath']).resolve()
    if not script.is_relative_to(ROOT) or script.suffix.lower() != '.py':
        raise RuntimeError('Worker script must be inside this project')
    launcher_pid = int(request['launcherPid'])
    worker = request.get('worker')
    launcher = matching_process(launcher_pid, script, token, request.get('launcherCreated'))
    candidates = {}
    if launcher:
        for child in launcher.children(recursive=True):
            if matching_process(child.pid, script, token, child.create_time()):
                candidates[child.pid] = child.create_time()
        candidates[launcher.pid] = launcher.create_time()
    if worker:
        actual = matching_process(worker['pid'], script, token, worker['created'])
        if actual:
            # The handshake established ownership while the launcher was alive.
            # The nonce + ctime also protect orphaned workers after its exit.
            candidates[actual.pid] = actual.create_time()
    killed, gone, refused, pending = [], [], [], []
    # Kill the actual worker before the redirector, never unrelated descendants.
    ordered = sorted(candidates, key=lambda pid: pid == launcher_pid)
    processes = []
    for pid in ordered:
        process = matching_process(pid, script, token, candidates[pid])
        if process is None:
            if not psutil.pid_exists(pid):
                gone.append(pid)
            else:
                refused.append(pid)
            continue
        try:
            process.kill()
            killed.append(pid)
            processes.append(process)
        except psutil.NoSuchProcess:
            gone.append(pid)
    _, alive = psutil.wait_procs(processes, timeout=2)
    pending = [p.pid for p in alive]
    # Explicitly recheck the reported worker; an empty candidate set cannot hide
    # a still-live matching worker after a discovery/termination failure.
    if worker and matching_process(worker['pid'], script, token, worker['created']):
        if worker['pid'] not in pending:
            pending.append(worker['pid'])
    return dict(terminated=not pending and not refused, killed=killed,
                alreadyGone=gone, refused=refused, pending=pending)


if __name__ == '__main__':
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        print(json.dumps(terminate(json.loads(sys.stdin.readline()))), flush=True)
    except Exception as error:
        print(json.dumps(dict(terminated=False, error=str(error))), flush=True)
        sys.exit(1)
