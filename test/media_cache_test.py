# Install the committed fictional registry before importing production adapters.
import pathlib as _test_pathlib
import sys as _test_sys
_test_sys.path.insert(0, str(_test_pathlib.Path(__file__).resolve().parent))
from native_test_bootstrap import configure_test_environment
configure_test_environment()

import io, pathlib, struct, sys, tempfile, unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import wechat_media_cache as media

class MediaCacheTests(unittest.TestCase):
    def setUp(self):
        self.native_patch=patch.dict(media.CONFIG,{"native":{"mediaCache":True}})
        self.native_patch.start();self.addCleanup(self.native_patch.stop)
    def test_disk_landmark_does_not_read_process_module_section(self):
        data=bytearray(1024);data[64:77]=b'global_config';struct.pack_into('<QQ',data,80,13,15)
        calls=[]
        result=media.module_config_landmark(bytes(data),(0x2000,1024,0,1024),lambda *args,**kw:calls.append(args),0x100000)
        self.assertEqual(result,0x2000+80);self.assertEqual(calls,[])

    def test_runtime_landmark_scan_requires_additional_opt_in_and_never_returns_bytes(self):
        disk=b'\0'*9000;runtime=bytearray(disk);runtime[4088:4101]=b'global_config';struct.pack_into('<QQ',runtime,4104,13,15)
        runtime[100:120]=b'synthetic_auth_bytes';calls=[]
        def read(addr,n,module=False):
            self.assertTrue(module);self.assertLessEqual(n,4096);start=addr-(0x100000+0x2000);self.assertGreaterEqual(start,0);self.assertLessEqual(start+n,len(runtime));calls.append((addr,n));return bytes(runtime[start:start+n])
        with self.assertRaisesRegex(ValueError,'scan_not_authorized'):media.module_config_landmark(disk,(0x2000,9000,0,9000),read,0x100000)
        self.assertEqual(calls,[])
        result=media.module_config_landmark(disk,(0x2000,9000,0,9000),read,0x100000,True)
        self.assertIsInstance(result,int);self.assertEqual(result,0x2000+4104);self.assertEqual(len(calls),3)

    def encrypted(self):
        raw=io.BytesIO();media.Image.new('RGB',(9,7),(80,120,20)).save(raw,'JPEG')
        data=raw.getvalue();key=b'0123456789abcdef';xor=41;aes_len=128
        prefix=data[:aes_len]+b'\x10'*16
        enc=media.Cipher(media.algorithms.AES(key),media.modes.ECB()).encryptor()
        cipher=enc.update(prefix)+enc.finalize()
        tail=data[aes_len:]
        return b'\x07\x08\x56\x32\x08\x07'+struct.pack('<II',aes_len,len(tail))+b'\x01'+cipher+bytes(x^xor for x in tail),key,xor

    def test_decodes_real_pixels_and_strips_container(self):
        data,key,xor=self.encrypted();image,size=media.decode_image(data,key,xor)
        self.assertEqual(size,(9,7));self.assertTrue(image.startswith(b'\xff\xd8\xff'))
        with media.Image.open(io.BytesIO(image)) as im:self.assertEqual(im.size,(9,7))

    def test_rejects_wrong_key_truncation_format_and_header(self):
        data,key,xor=self.encrypted()
        for payload,cipher in [(data,b'xxxxxxxxxxxxxxxx'),(data[:-20],key),(b'bad'+data,key),(data[:6]+b'\xff'*8+data[14:],key)]:
            with self.assertRaises((ValueError,OSError)):media.decode_image(payload,cipher,xor)

    def test_unapproved_group_fails_before_key_or_directory_read(self):
        with patch.object(media,'image_key',side_effect=AssertionError('key must not be read')):
            with self.assertRaisesRegex(ValueError,'scope_denied'):media.recent_images('third_group',1,2)

    def test_only_exact_peer_directory_is_enumerated(self):
        with tempfile.TemporaryDirectory(dir=media.ROOT/'temp',prefix='media_scope_test_') as tmp:
            root=pathlib.Path(tmp)
            approved=root/media.hashlib.md5(media.PEERS['group_abao'].encode()).hexdigest()/'2026-10'/'Img'
            approved.mkdir(parents=True);(approved/('a'*32+'.dat')).write_bytes(b'x'*32)
            other=root/'other_private_peer';other.mkdir();(other/'never_read.txt').write_text('outside scope')
            with patch.object(media,'CACHE_ROOT',root):
                rows=media.scoped_files('group_abao');self.assertEqual(len(rows),1);self.assertEqual(rows[0][0].parent,approved)

    def test_escape_path_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'scope_denied'):media.safe_path(pathlib.Path('D:/other/file'),media.CACHE_ROOT)

    def test_wxgf_selects_picture_partition_instead_of_first_alpha_mask(self):
        prefix=b'\0\0\0\1\x40\x01'
        mask=prefix+b'a'*20;picture=prefix+b'b'*180
        header=b'wxgf'+bytes([16])+b'\0'*11
        container=header+len(mask).to_bytes(4,'big')+mask+len(picture).to_bytes(4,'big')+picture
        self.assertEqual(media.wxgf_picture_stream(container),picture)
        with self.assertRaises(ValueError):media.wxgf_picture_stream(container[:-10])

if __name__=='__main__':unittest.main()
