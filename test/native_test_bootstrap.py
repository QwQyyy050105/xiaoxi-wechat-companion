"""Test-only owner registry: never load deployment.local.json or caller owner files."""
import json
import os
import pathlib
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'test' / 'fixtures' / 'deployment.json'

def configure_test_environment():
    if FIXTURE.is_symlink() or not FIXTURE.is_file():
        raise RuntimeError('synthetic_test_fixture_missing')
    value = json.loads(FIXTURE.read_text(encoding='utf-8-sig'))
    if value.get('schemaVersion') != 1 or value.get('native', {}).get('enabled') is not False:
        raise RuntimeError('synthetic_test_fixture_invalid')
    os.environ['XIAOXI_CONFIG'] = str(FIXTURE)
    temp = ROOT / 'temp'
    temp.mkdir(exist_ok=True)
    os.environ['TEMP'] = os.environ['TMP'] = str(temp)
    tempfile.tempdir = str(temp)
    return value
