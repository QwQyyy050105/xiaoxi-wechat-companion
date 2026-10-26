import json
import pathlib
import shutil
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from focus_guard import FocusLease, NOACTIVATE


class FakeWindows:
    def __init__(self):
        self.current_style = 0x100
        self.current_cookie = 0
        self.current_owner = 10
        self.process_alive = True
        self.mutations = []
        self.before_cookie = lambda: None

    def process_matches(self, pid, created):
        return self.process_alive and pid == 10 and created == 100

    def owner(self, hwnd):
        return self.current_owner if hwnd == 20 else None

    def title(self, hwnd):
        return 'allowed'

    def style(self, hwnd):
        return self.current_style

    def set_style(self, hwnd, value):
        self.mutations.append(('style', value))
        self.current_style = value

    def cookie(self, hwnd):
        return self.current_cookie

    def set_cookie(self, hwnd, value):
        self.before_cookie()
        self.mutations.append(('cookie', value))
        self.current_cookie = value

    def remove_cookie(self, hwnd, expected):
        assert self.current_cookie == expected
        self.mutations.append(('remove_cookie', expected))
        self.current_cookie = 0


class FocusGuards(unittest.TestCase):
    def setUp(self):
        self.directory = pathlib.Path(tempfile.mkdtemp(prefix='focus_guard_test_', dir=ROOT / 'temp'))
        self.receipt = self.directory / 'lease.json'
        self.windows = FakeWindows()
        self.lease = FocusLease(self.windows, self.receipt)
        self.request = dict(pid=10, created=100, hwnd=20, title='allowed', parent=1)

    def tearDown(self):
        resolved = self.directory.resolve()
        self.assertEqual(resolved.parent, (ROOT / 'temp').resolve())
        self.assertTrue(resolved.name.startswith('focus_guard_test_'))
        shutil.rmtree(resolved)

    def test_durable_intent_precedes_first_mutation_and_preserves_other_style_changes(self):
        def assert_intent():
            record = json.loads(self.receipt.read_text(encoding='utf-8'))
            self.assertFalse(record['released'])
            self.assertFalse(record['originalNoActivate'])
        self.windows.before_cookie = assert_intent
        self.assertTrue(self.lease.acquire(self.request)['ready'])
        self.windows.current_style |= 0x200
        self.assertTrue(self.lease.release())
        self.assertEqual(self.windows.current_style, 0x300)
        self.assertEqual(self.windows.current_cookie, 0)

    def test_preexisting_noactivate_bit_is_retained(self):
        self.windows.current_style |= NOACTIVATE
        self.lease.acquire(self.request)
        self.lease.release()
        self.assertTrue(self.windows.current_style & NOACTIVATE)

    def test_reused_hwnd_cookie_is_never_modified(self):
        self.lease.acquire(self.request)
        self.windows.current_cookie = 99
        self.windows.current_style = 0x444
        self.windows.mutations.clear()
        self.assertFalse(self.lease.release())
        self.assertEqual(self.windows.mutations, [])
        self.assertEqual(self.windows.current_style, 0x444)

    def test_replaced_process_is_never_modified(self):
        self.lease.acquire(self.request)
        self.windows.process_alive = False
        self.windows.mutations.clear()
        self.assertFalse(self.lease.release())
        self.assertEqual(self.windows.mutations, [])

    def test_next_guard_recovers_interrupted_lease_before_acquiring(self):
        self.lease.acquire(self.request)
        self.windows.current_style |= 0x200
        next_lease = FocusLease(self.windows, self.receipt)
        next_lease.acquire(self.request)
        self.assertTrue(next_lease.record['priorRecovery']['restored'])
        self.assertFalse(next_lease.record['originalNoActivate'])
        next_lease.release()
        self.assertEqual(self.windows.current_style, 0x300)

    def test_wrong_title_or_owner_prevents_mutations(self):
        for key, value in [('title', 'different'), ('pid', 999), ('created', 101)]:
            with self.subTest(key=key):
                request = dict(self.request, **{key: value})
                with self.assertRaises(RuntimeError):
                    self.lease.acquire(request)
                self.assertEqual(self.windows.mutations, [])

    def test_failed_restore_remains_pending_for_next_guard_recovery(self):
        self.lease.acquire(self.request)
        original_set = self.windows.set_style
        def fail_restore(*_):
            raise OSError('style write blocked')
        self.windows.set_style = fail_restore
        self.assertFalse(self.lease.release())
        pending = json.loads(self.receipt.read_text(encoding='utf-8'))
        self.assertFalse(pending['released'])
        self.assertEqual(pending['releaseReason'], 'restore_failed')
        self.windows.set_style = original_set
        next_lease = FocusLease(self.windows, self.receipt)
        next_lease.acquire(self.request)
        self.assertTrue(next_lease.record['priorRecovery']['restored'])
        self.assertTrue(next_lease.release())
        self.assertEqual(self.windows.current_style, 0x100)

    def test_unknown_cookie_is_not_overwritten(self):
        self.windows.current_cookie = 123
        with self.assertRaisesRegex(RuntimeError, '未知保护标记'):
            self.lease.acquire(self.request)
        self.assertEqual(self.windows.mutations, [])


if __name__ == '__main__':
    unittest.main()

