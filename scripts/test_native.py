"""Run offline native tests with the committed fictional owner fixture."""
import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'test'))
from native_test_bootstrap import configure_test_environment
config = configure_test_environment()

if sys.argv[1:] == ['--check']:
    sys.path.insert(0, str(ROOT / 'scripts'))
    from owner_config import AUTHORIZED_GROUPS, CONFIG
    print(json.dumps(dict(ok=True, mode='synthetic_fixture', authorizedGroups=len(AUTHORIZED_GROUPS),
                          nativeEnabled=CONFIG.get('native', {}).get('enabled') is True,
                          ownerConfigUsed=False)))
    raise SystemExit(0)
if sys.argv[1:]:
    raise SystemExit('Usage: python -B scripts/test_native.py [--check]')
suite = unittest.defaultTestLoader.discover(str(ROOT / 'test'), pattern='*_test.py')
result = unittest.TextTestRunner(verbosity=1).run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
