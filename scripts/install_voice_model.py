"""Install the optional local Mandarin recognizer under this checkout."""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NAME = "vosk-model-small-cn-0.22"
SHA256 = "3af8b0e7e0f835ae9d414ce5df580237a3cfb08d586c9fbbb0f7ff29ad5b14ba"
URL = f"https://alphacephei.com/vosk/models/{NAME}.zip"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Use a previously downloaded official model ZIP")
    args = parser.parse_args()
    temp = ROOT / "temp"
    temp.mkdir(exist_ok=True)
    env = {**os.environ, "TEMP": str(temp), "TMP": str(temp), "TMPDIR": str(temp),
           "PIP_CACHE_DIR": str(ROOT / ".pip_cache"), "PYTHONDONTWRITEBYTECODE": "1"}
    runtime = ROOT / "runtime" / "asr"
    python = runtime / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.is_file():
        subprocess.run([sys.executable, "-B", "-m", "venv", str(runtime)], env=env, check=True)
    subprocess.run([str(python), "-B", "-m", "pip", "install", "--disable-pip-version-check", "vosk==0.3.45"], env=env, check=True)
    models = ROOT / "runtime" / "asr_models"
    models.mkdir(parents=True, exist_ok=True)
    destination = models / NAME
    if not destination.exists():
        with tempfile.TemporaryDirectory(dir=temp, prefix="vosk_install_") as stage:
            stage = Path(stage)
            archive = args.archive
            if archive is None:
                archive = stage / "model.zip"
                with urllib.request.urlopen(URL, timeout=60) as response, archive.open("wb") as output:
                    shutil.copyfileobj(response, output)
            digest = hashlib.sha256()
            with archive.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != SHA256:
                raise SystemExit("Model ZIP checksum does not match the supported official release.")
            with zipfile.ZipFile(archive) as package:
                package.extractall(stage)
            (stage / NAME).rename(destination)
    if not (destination / "am" / "final.mdl").is_file():
        raise SystemExit("The existing model directory is incomplete. Inspect runtime/asr_models before retrying.")
    print("Installed the offline Mandarin recognizer:", destination)


if __name__ == "__main__":
    main()
