"""Inspect the Windows-signed executable selected by account binding."""
import os
from pathlib import Path
import re
import subprocess

LEGACY_BUILD = '4.1.15.56'
STANDALONE_SEND_BUILD = '4.2.0.53'
PUBLISHER = 'Tencent Technology (Shenzhen) Company Limited'


def verified_build(executable):
    path = Path(executable)
    if not path.is_absolute() or path.name.lower() != 'weixin.exe':
        raise RuntimeError('微信运行文件的名称或路径无效')
    # Supply the path as data. A localized version string can contain vendor
    # suffixes; read the four numeric fixed-file-version components instead.
    command = """
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
$path=$env:XIAOXI_INSPECT_WEIXIN
$signature=Get-AuthenticodeSignature -LiteralPath $path
if($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate){exit 2}
$signature.SignerCertificate.GetNameInfo('SimpleName',$false)
$v=[Diagnostics.FileVersionInfo]::GetVersionInfo($path)
'{0}.{1}.{2}.{3}' -f $v.FileMajorPart,$v.FileMinorPart,$v.FileBuildPart,$v.FilePrivatePart
"""
    shell = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    try:
        result = subprocess.run(
            [str(shell), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
            env={**os.environ, 'XIAOXI_INSPECT_WEIXIN': str(path)},
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=12,
            creationflags=subprocess.CREATE_NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError('Windows 未能完成微信签名和版本核验') from error
    lines = result.stdout.decode('ascii', errors='replace').splitlines()
    if (result.returncode or len(lines) != 2 or lines[0] != PUBLISHER
            or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){3}', lines[1])):
        raise RuntimeError('微信文件的腾讯签名或版本未通过核验')
    return lines[1]
