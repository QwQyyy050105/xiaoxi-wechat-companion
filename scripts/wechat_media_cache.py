"""Read-only media access for the owner-configured approved WeChat groups.

No chat database, account-wide attachment walk, clipboard, window capture,
input events, credential export, memory writes or key files. Cache ordering is
NOT message ordering and MUST NOT be used to invent a sender/message binding.
V2 format/config-layout research: fanyuantaier/wechatauto-replica,
commit 5d29e297aee095df65785fc8386af77506554698 (Apache-2.0).
"""
from __future__ import annotations
import base64, ctypes as C, hashlib, io, json, pathlib, re, struct, sys, time, subprocess, os
import psutil
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from PIL import Image, ImageOps
from accessibility_trial import K, loaded_dll

ROOT = pathlib.Path(__file__).resolve().parents[1]
from owner_config import CONFIG
ACCOUNT=CONFIG.get('account',{}).get('folder','')
WXID=CONFIG.get('account',{}).get('wxid','')
CACHE_ROOT=pathlib.Path(CONFIG.get('account',{}).get('cacheRoot') or ROOT/'data'/'unconfigured_media')
PEERS={t['id']:t['wechatPeerId'] for t in CONFIG.get('targets',[]) if t['kind']=='group' and t.get('wechatPeerId')}
DLL_SHA = 'e0428a7b691853de496532523c2c09aa095f90941c37c9f4cfb3f137f3c66556'
MAX_FILE = 16 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 24000000


def safe_path(path, root):
    """Reject junction/symlink escapes, including ancestors of the scope root."""
    path, root = pathlib.Path(path), pathlib.Path(root)
    if not path.is_relative_to(root):
        raise ValueError('media_scope_denied')
    for part in [path, *path.parents]:
        if part.is_symlink() or part.is_junction():
            raise ValueError('media_reparse_denied')
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('media_scope_denied')
    return path


def scoped_files(target):
    if CONFIG.get('native',{}).get('mediaCache') is not True or target not in PEERS:
        raise ValueError('media_scope_denied')
    folder = CACHE_ROOT / hashlib.md5(PEERS[target].encode()).hexdigest()
    safe_path(folder, CACHE_ROOT)
    if not folder.is_dir():
        return []
    rows = []
    # Only enumerate this exact approved peer; never enumerate sibling peers.
    for month in folder.iterdir():
        if not re.fullmatch(r'20\d\d-(?:0[1-9]|1[0-2])', month.name):
            continue
        img = safe_path(month / 'Img', folder)
        if not img.is_dir():
            continue
        for file in img.iterdir():
            if not re.fullmatch(r'[a-f0-9]{32}(?:_[th])?\.dat', file.name):
                continue
            safe_path(file, folder)
            st = file.stat()
            if file.is_file() and 15 < st.st_size <= MAX_FILE:
                rows.append((file, st))
    return rows


def process_identity(pid, created):
    p = psutil.Process(pid)
    if p.name().lower() != 'weixin.exe' or abs(p.create_time() - created) > .001:
        raise ValueError('media_account_changed')
    folders = set()
    for item in p.open_files():
        match = re.search(r'\\xwechat_files\\(wxid_[^\\]+)\\db_storage\\', item.path, re.I)
        if match:
            folders.add(match.group(1).lower())
    if folders != {ACCOUNT}:
        raise ValueError('media_account_mismatch')


def config_landmark_offsets(data):
    """Return offsets only; never return or log module bytes."""
    return [m.start()+16 for m in re.finditer(b'global_config',data)
            if m.start()%8==0 and m.start()+32<=len(data)
            and struct.unpack_from('<QQ',data,m.start()+16)==(13,15)]


def module_config_landmark(raw, section, read, base, allow_scan=False):
    """Prefer a unique on-disk .data landmark, with no segment-memory scan.

    Some builds initialize the string at runtime. Only an extra owner opt-in
    permits a bounded .data scan then. Chunks stay transient and are never
    returned, logged, persisted or included in the worker JSON response.
    """
    rva,length,raw_offset,raw_size=section
    if not 0<length<32*1024*1024 or raw_offset<0 or raw_size<0 or raw_offset+raw_size>len(raw):raise ValueError('media_config_section_invalid')
    disk=config_landmark_offsets(raw[raw_offset:raw_offset+min(raw_size,length)])
    if len(disk)==1:return rva+disk[0]
    if len(disk)>1:raise ValueError('media_config_landmark_ambiguous')
    if not allow_scan:raise ValueError('media_module_data_scan_not_authorized')
    candidates=set();carry=b''
    for offset in range(0,length,4096):
        chunk=read(base+rva+offset,min(4096,length-offset),module=True)
        data=carry+chunk;start=offset-len(carry)
        # Align against the actual section offset, including overlapping chunks.
        for match in re.finditer(b'global_config',data):
            pos=match.start();absolute=start+pos
            if absolute%8==0 and pos+32<=len(data) and struct.unpack_from('<QQ',data,pos+16)==(13,15):
                candidates.add(rva+absolute+16)
        carry=data[-31:]
    if len(candidates)!=1:raise ValueError('media_config_landmark_ambiguous')
    return next(iter(candidates))


def image_key(pid, created):
    """Exact-build image decoder metadata, with no database/heap scan.

    On-disk landmark lookup is preferred. Extra allowModuleDataScan opt-in
    permits a transient <=32MiB .data scan if the landmark is runtime-created;
    this may read unrelated bytes in that module section, including sensitive
    data. Segment bytes and derived keys are never persisted or serialized.
    After locating it, only the required pointers/account/dword are read.
    """
    process_identity(pid, created)
    dll, base, size = loaded_dll(pid)
    raw = dll.read_bytes()
    if hashlib.sha256(raw).hexdigest() != DLL_SHA:
        raise ValueError('media_version_unverified')
    pe = struct.unpack_from('<I', raw, 60)[0]
    count = struct.unpack_from('<H', raw, pe + 6)[0]
    opt = struct.unpack_from('<H', raw, pe + 20)[0]
    sections = []
    for i in range(count):
        at = pe + 24 + opt + 40 * i
        if raw[at:at+8].split(b'\0')[0] == b'.data':
            vsize, rva = struct.unpack_from('<II', raw, at + 8)
            if 0 < vsize < 32 * 1024 * 1024 and rva + vsize <= size:
                raw_size,raw_offset=struct.unpack_from('<II',raw,at+16)
                if raw_offset+raw_size>len(raw):raise ValueError('media_config_section_invalid')
                sections.append((rva,vsize,raw_offset,raw_size))
    if len(sections) != 1:
        raise ValueError('media_config_section_invalid')
    h = K.OpenProcess(0x410, False, pid)
    if not h:
        raise ValueError('media_process_permission')
    def read(addr, n, module=False):
        section_rva,section_length,*_=sections[0]
        permitted=(0<n<=4096 and base+section_rva<=addr and addr+n<=base+section_rva+section_length) if module else 0<n<=256
        if not 0x10000 <= addr < 0x800000000000 or not permitted:
            raise ValueError('media_config_pointer_invalid')
        buf = C.create_string_buffer(n); got = C.c_size_t()
        if not K.ReadProcessMemory(h, C.c_void_p(addr), buf, n, C.byref(got)) or got.value != n:
            raise ValueError('media_config_read_failed')
        return buf.raw
    try:
        landmark=module_config_landmark(raw,sections[0],read,base,CONFIG.get('native',{}).get('allowModuleDataScan') is True)
        parent = struct.unpack('<Q', read(base + landmark - 0x138, 8))[0]
        cfg = struct.unpack('<Q', read(parent + 0x68, 8))[0]
        meta = read(cfg + 0x48, 32)
        strlen, cap = struct.unpack_from('<QQ', meta, 16)
        if not 1 <= strlen <= 64 or cap < strlen or cap > 256:
            raise ValueError('media_config_account_invalid')
        value = (meta[:strlen] if cap <= 15 else read(struct.unpack_from('<Q', meta)[0], strlen)).decode('ascii')
        if value != WXID:
            raise ValueError('media_config_account_mismatch')
        dword = struct.unpack('<I', read(cfg + 0x40, 4))[0]
        process_identity(pid, created)
        return hashlib.md5((str(dword) + value).encode()).hexdigest()[:16].encode(), dword & 255
    finally:
        K.CloseHandle(h)


def wxgf_picture_stream(container):
    """WXGF stores length-prefixed HEVC partitions, sometimes alpha first.

    Format reference: sjzar/chatlog a16b689, wxgf.go. Select the dominant
    independently bounded picture partition, not the first NAL in the file.
    Ambiguous multi-frame/animation containers fall back to their thumbnail.
    """
    if len(container) < 16 or container[:4] != b'wxgf':
        raise ValueError('media_container_invalid')
    beginning = container[4]
    if not 8 <= beginning < len(container):
        raise ValueError('media_container_invalid')
    parts = []
    for prefix in (b'\0\0\0\1', b'\0\0\1'):
        pos = beginning
        while pos < len(container):
            at = container.find(prefix, pos)
            if at < 0:
                break
            pos = at + 1
            length = int.from_bytes(container[at-4:at], 'big')
            if length < 16 or at + length > len(container):
                continue
            nalu = at + len(prefix)
            if nalu + 2 > len(container) or (container[nalu] >> 1) & 63 not in (32, 33, 34, 39):
                continue
            parts.append(container[at:at+length]);pos = at + length
        if parts:
            break
    if not parts:
        raise ValueError('media_container_partition_missing')
    picture = max(parts, key=len)
    if len(parts) > 2 or len(picture) / len(container) < .6:
        raise ValueError('media_animation_requires_thumbnail')
    return picture


def decode_image(data, key, xor):
    if data[:6] != b'\x07\x08\x56\x32\x08\x07' or len(data) > MAX_FILE:
        raise ValueError('media_format_unsupported')
    aes_size, xor_size = struct.unpack_from('<II', data, 6)
    encrypted = (aes_size // 16 + 1) * 16
    if not 0 < aes_size <= MAX_FILE or 15 + encrypted + xor_size > len(data):
        raise ValueError('media_header_invalid')
    dec = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    first = dec.update(data[15:15+encrypted]) + dec.finalize()
    pad = first[-1]
    if not 1 <= pad <= 16 or first[-pad:] != bytes([pad])*pad or len(first)-pad != aes_size:
        raise ValueError('media_key_validation_failed')
    end = len(data)-xor_size
    plain = first[:-pad] + data[15+encrypted:end] + bytes(b ^ xor for b in data[end:])
    if plain.startswith(b'wxgf'):
        import imageio_ffmpeg
        hevc = wxgf_picture_stream(plain)
        # No filenames/URLs from the message. Only bounded bytes on stdin;
        # HEVC decoder, one frame, CPU, pipe-only I/O, no desktop interaction.
        converted = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error',
                                    '-protocol_whitelist', 'pipe', '-threads', '1',
                                    '-f', 'hevc', '-i', 'pipe:0', '-frames:v', '1',
                                    '-vf', "scale=w='min(1600,iw)':h='min(1600,ih)':force_original_aspect_ratio=decrease",
                                    '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
                                   input=hevc, capture_output=True, timeout=8,
                                   cwd=ROOT, creationflags=0x08000000,
                                   env={**os.environ,'TEMP':str(ROOT/'temp'),'TMP':str(ROOT/'temp')})
        if converted.returncode or not converted.stdout.startswith(b'\xff\xd8\xff'):
            raise ValueError('media_container_decode_failed')
        plain = converted.stdout
    # Decode fully before trusting the format. Strip metadata, normalize to JPEG.
    with Image.open(io.BytesIO(plain)) as image:
        image.seek(0); image.load()
        width, height = image.size
        if width*height > 24000000:
            raise ValueError('media_pixel_limit')
        normalized = ImageOps.exif_transpose(image).convert('RGB')
        normalized.thumbnail((1600, 1600))
        out = io.BytesIO(); normalized.save(out, 'JPEG', quality=88)
    return out.getvalue(), (width, height)


def recent_images(target, pid, created, limit=2, max_age_hours=48):
    rows = scoped_files(target)
    # Prefer full cache over its thumbnail. These are group-cache candidates,
    # deliberately not assigned to a message, sender, or platform timestamp.
    chosen = {}
    for p, st in rows:
        if not -60 <= time.time()-st.st_mtime <= max_age_hours*3600:
            continue
        stem = p.name[:32]
        chosen.setdefault(stem, []).append((p, st))
    rank = lambda file: 2 if file.stem.endswith('_h') else 0 if file.stem.endswith('_t') else 1
    ordered = sorted(chosen.values(), key=lambda group: max(st.st_mtime for _,st in group), reverse=True)[:min(2, max(1, limit))]
    if not ordered:
        return []
    key, xor = image_key(pid, created)
    result = []
    for group in ordered:
        decoded = None
        for file, before in sorted(group, key=lambda pair:rank(pair[0]), reverse=True):
            safe_path(file, CACHE_ROOT / hashlib.md5(PEERS[target].encode()).hexdigest())
            data = file.read_bytes(); after = file.stat()
            if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
                continue
            try:
                image, size = decode_image(data, key, xor)
                decoded = (image, size)
                break
            except (ValueError, OSError, subprocess.TimeoutExpired):
                continue
        if decoded is None:
            continue
        result.append(dict(targetId=target, peerId=PEERS[target], source='wechat_group_cache',
                           sha256=hashlib.sha256(image).hexdigest(), cacheModifiedAt=after.st_mtime,
                           messageBinding='unresolved', sender=None, width=size[0], height=size[1],
                           quality='thumbnail' if file.stem.endswith('_t') else 'original' if file.stem.endswith('_h') else 'wechat_compressed',
                           mime='image/jpeg', data=base64.b64encode(image).decode()))
    process_identity(pid, created)
    return result


if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.readline())
        images = recent_images(request['targetId'], int(request['pid']), float(request['created']))
        if request.get('diagnostic'):
            images = [{k:v for k,v in row.items() if k != 'data'} for row in images]
        print(json.dumps({'ok':True,'images':images}, ensure_ascii=False), flush=True)
    except Exception as error:
        # No keys, memory addresses, decrypted payload or user filenames in errors.
        code = str(error) if re.fullmatch(r'media_[a-z_]+', str(error)) else 'media_read_failed'
        print(json.dumps({'ok':False,'reason':code}), flush=True)
