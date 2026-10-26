# Third-party references

The native accessibility diagnostic was informed by the Qt accessibility-gate
research and machine-code signature in `fanyuantaier/wechatauto-replica`,
`wechatauto/accessibility.py`, retrieved on 2026-10-23:

https://github.com/fanyuantaier/wechatauto-replica/blob/main/wechatauto/accessibility.py

Upstream license: Apache License 2.0, retained in
`licenses/wechatauto_apache2.txt`. The local scripts are a reduced diagnostic
implementation with explicit process-instance checks, file-hash validation,
no fallback addresses, bounded control inspection and restoration of the one
temporary data byte. The upstream package is not installed or imported. Its
database decryption/key-extraction functionality is not used.

The image-only cache reader added on 2026-10-25 was informed by `db.py`'s
config layout and `media.py`'s V2 image container / WXGF research at commit
`5d29e297aee095df65785fc8386af77506554698` of the same Apache-2.0 project.
It is a separate reduced implementation: exact DLL hash, account-instance
validation, disk-first module config landmark lookup and bounded pointer reads.
An additional owner opt-in permits a transient scan of the exact module .data
section (<32MiB, chunks <=4KiB) if the landmark exists only at runtime; this can
read unrelated sensitive bytes inside that section. Segment bytes and derived
keys are never persisted, logged or serialized. No full-heap scan, database
queries, credential export or persistent key files is performed.
Only explicitly owner-configured peer-hash image directories are enumerated.
Cache images are explicitly unbound to message IDs/senders. Upstream's package,
full-account cache walk, key export and database decryptor are not installed.

Image decoding uses cryptography 50.0.2 (Apache-2.0 OR BSD-3-Clause),
Pillow 13.0.0 (MIT-CMU) and imageio-ffmpeg 0.6.0 (BSD-2-Clause wrapper;
bundled FFmpeg's own license applies). Installed distribution metadata and
license files remain alongside each installed package in the owner's chosen runtime.
FFmpeg is used only as a bounded, CPU, pipe-to-pipe HEVC picture decoder.
WXGF length-prefixed partition format was also checked against the research
in `sjzar/chatlog` revision `a16b689`, `pkg/util/dat2img/wxgf.go`:
https://github.com/sjzar/chatlog/blob/a16b689/pkg/util/dat2img/wxgf.go
The upstream module is not imported or vendored. The local format parser rejects
ambiguous animation partitions and avoids mistaking an alpha mask for a picture.

The optional iLink text adapter is separate from the Windows group adapter. It is not used by the default runtime and provides no claim of ordinary group-chat support.
