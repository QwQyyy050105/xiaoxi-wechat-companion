"""Read-only PE inspection for the native WeChat accessibility diagnostic.

Examines the installed DLL file only. Does not open process memory, modify any
file outside this project, read chat databases, or activate a runtime flag.
Pattern research: fanyuantaier/wechatauto-replica, accessibility.py (Apache-2.0).
Candidates are diagnostic evidence, NOT proof that modifying them is safe.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import pathlib
import re
import struct
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]

def inspect_file(path: pathlib.Path) -> dict:
    data = path.read_bytes()
    if data[:2] != b'MZ':
        raise ValueError('Not a PE file')
    pe = struct.unpack_from('<I', data, 60)[0]
    if data[pe:pe+4] != b'PE\0\0':
        raise ValueError('Invalid PE signature')
    machine, count = struct.unpack_from('<HH', data, pe+4)
    opt_size = struct.unpack_from('<H', data, pe+20)[0]
    if machine != 0x8664:
        raise ValueError('Requires AMD64 file')
    sections = []
    for index in range(count):
        offset = pe + 24 + opt_size + index*40
        name = data[offset:offset+8].split(b'\0')[0].decode('ascii')
        virtual_size, rva, raw_size, raw = struct.unpack_from('<IIII', data, offset+8)
        flags = struct.unpack_from('<I', data, offset+36)[0]
        sections.append(dict(name=name,rva=rva,raw=raw,size=raw_size,vsize=virtual_size,flags=flags))
    def from_offset(offset):
        for section in sections:
            if section['raw'] <= offset < section['raw']+section['size']:
                return section['rva']+offset-section['raw']
        return None
    def section_at(rva):
        return next((s for s in sections if s['rva'] <= rva < s['rva']+max(s['size'],s['vsize'])),None)
    marker = data.find(b'qt.accessibility.core')
    marker_rva = from_offset(marker)
    references = []
    if marker_rva is not None:
        for section in sections:
            if not section['flags'] & 0x20000000:
                continue
            # AMD64 RIP-relative LEA: optional REX, 8D, ModRM, disp32.
            for match in re.finditer(rb'\x8d[\x05\x0d\x15\x1d\x25\x2d\x35\x3d]',data[section['raw']:section['raw']+section['size']]):
                pos = section['raw']+match.start()
                if pos+6 > len(data):
                    continue
                rva = from_offset(pos)
                displacement = struct.unpack_from('<i',data,pos+2)[0]
                if rva+6+displacement == marker_rva:
                    references.append(rva)
    candidates = []
    pattern = re.compile(rb'\x48\x85\xc9\x0f\x84....\x80\x3d(.{4})\x00\x0f\x84',re.DOTALL)
    for match in pattern.finditer(data):
        code_rva = from_offset(match.start())
        displacement_rva = from_offset(match.start(1))
        if code_rva is None or displacement_rva is None:
            continue
        target = displacement_rva+5+struct.unpack('<i',match.group(1))[0]
        code_section,target_section=section_at(code_rva),section_at(target)
        if not code_section or not code_section['flags'] & 0x20000000:
            continue
        if not target_section or not target_section['flags'] & 0x80000000:
            continue
        candidates.append({'rva':target,'rva_hex':hex(target),'code_rva':hex(code_rva),'section':target_section['name'],
                           'nearest_marker_reference':min((abs(code_rva-x) for x in references),default=None)})
    candidates.sort(key=lambda x:x['nearest_marker_reference'] if x['nearest_marker_reference'] is not None else 2**63)
    close = [c for c in candidates if c['nearest_marker_reference'] is not None and c['nearest_marker_reference']<=0x20000]
    return {'recorded_at':datetime.now(timezone.utc).isoformat(),'mode':'file_only_read_only','dll_path':str(path),
            'size':len(data),'sha256':hashlib.sha256(data).hexdigest(),'version_directory':path.parent.name,
            'marker_found':marker>=0,'marker_reference_count':len(references),'candidates':candidates,
            'close_candidate_count':len({c['rva'] for c in close}),
            'runtime_change_performed':False,'runtime_compatibility_verified':False}

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--dll',type=pathlib.Path,required=True)
    args=parser.parse_args()
    report=inspect_file(args.dll.resolve(strict=True))
    builds=json.loads((ROOT/'native_builds.json').read_text(encoding='utf-8'))['builds']
    if not any(b['version']==report['version_directory'] and b['dllSha256']==report['sha256'] for b in builds):raise RuntimeError('unsupported_wechat_build: no runtime flag was changed')
    (ROOT/'data').mkdir(parents=True,exist_ok=True)
    output=ROOT/'data'/'accessibility_compatibility.json'
    output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))
