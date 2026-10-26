"""Process-bound UIA lease. EOF, missed heartbeats or parent exit restore the byte."""
import sys, json, pathlib, hashlib, threading, time, ctypes as C
import psutil
from accessibility_trial import K, loaded_dll, read_byte, write_byte

ROOT = pathlib.Path(__file__).resolve().parents[1]
K.CreateMutexW.argtypes=[C.c_void_p,C.c_int,C.c_wchar_p];K.CreateMutexW.restype=C.c_void_p

def main():
    mutex=K.CreateMutexW(None,False,'Local\\XiaoxiWeChatAccessibilityLease')
    if not mutex or C.get_last_error()==183:raise RuntimeError('已有微信连接守护进程，请稍后重试')
    request = json.loads(sys.stdin.readline())
    pid, created = int(request['pid']), float(request['created'])
    parent = psutil.Process(int(request['parent']))
    parent_created = parent.create_time()
    process = psutil.Process(pid)
    if process.name().lower() != 'weixin.exe' or abs(process.create_time()-created) > .001:
        raise RuntimeError('微信进程已经改变')
    dll, base, size = loaded_dll(pid)
    builds=json.loads((ROOT/'native_builds.json').read_text(encoding='utf-8'))['builds']
    digest=hashlib.sha256(dll.read_bytes()).hexdigest()
    if not any(b['version']==dll.parent.name and b['dllSha256']==digest for b in builds):raise RuntimeError('unsupported_wechat_build')
    if not (ROOT/'data/accessibility_compatibility.json').is_file():raise RuntimeError('native_prepare_required: run npm run native:prepare -- --dll FULL_PATH')
    known = json.loads((ROOT/'data/accessibility_compatibility.json').read_text(encoding='utf-8'))
    if str(dll.resolve()).lower() != str(pathlib.Path(known['dll_path']).resolve()).lower() or hashlib.sha256(dll.read_bytes()).hexdigest() != known['sha256']:
        raise RuntimeError('微信版本变化，需要重新验证兼容性')
    candidates = [x for x in known['candidates'] if x['nearest_marker_reference'] is not None and x['nearest_marker_reference'] <= 0x20000]
    if len(candidates) != 1 or candidates[0]['section'] != '.data' or not 0 < candidates[0]['rva'] < size:
        raise RuntimeError('兼容位置不唯一')
    handle = K.OpenProcess(0x438, False, pid)
    if not handle: raise C.WinError(C.get_last_error())
    address = base + candidates[0]['rva']
    original = read_byte(handle, address)
    if original not in (0,1): raise RuntimeError('兼容开关状态异常')
    receipt = ROOT/'data/accessibility_lease.json'
    record = dict(pid=pid,created=created,rva=candidates[0]['rva'],original=original,restored=False)
    # Recover a lease whose guard was killed while this exact WeChat process survived.
    if receipt.exists():
        prior = json.loads(receipt.read_text(encoding='utf-8'))
        if not prior.get('restored') and prior.get('pid') == pid and abs(prior.get('created',0)-created)<.001 and prior.get('rva')==record['rva']:
            original=prior['original']; record['original']=original
    def save():
        temp=receipt.with_suffix('.new'); temp.write_text(json.dumps(record),encoding='utf-8');temp.replace(receipt)
    save()
    stopped=threading.Event(); beat=[time.monotonic()]
    def reader():
        for line in sys.stdin:
            if line.strip() == 'stop': break
            beat[0]=time.monotonic()
        stopped.set()
    threading.Thread(target=reader,daemon=True).start()
    try:
        write_byte(handle,address,1)
        print(json.dumps({'ready':True,'pid':pid}),flush=True)
        while not stopped.wait(.5):
            if time.monotonic()-beat[0]>15 or not parent.is_running() or parent.create_time()!=parent_created: break
            if not process.is_running() or process.create_time()!=created: break
    finally:
        try:
            if process.is_running() and process.create_time()==created:
                write_byte(handle,address,original)
            record['restored']=True
        except Exception: record['restored']=False
        K.CloseHandle(handle); save()
        print(json.dumps({'stopped':True,'restored':record['restored']}),flush=True)

if __name__=='__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'error':str(error)},ensure_ascii=False),flush=True);sys.exit(1)
