param([string]$ClientPath, [string]$OutputDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'

# Auto-discovery happens only at build time. The executable stores the owner's
# chosen absolute installation path and revalidates the image before every launch.
if (!$ClientPath) {
    $install=(Get-ItemProperty -LiteralPath 'HKCU:\Software\Tencent\Weixin' -ErrorAction SilentlyContinue).InstallPath
    if ($install) { $ClientPath=Join-Path $install 'Weixin.exe' }
    else { $ClientPath=Join-Path $env:ProgramFiles 'Tencent\Weixin\Weixin.exe' }
}
if (![IO.Path]::IsPathRooted($ClientPath) -or $ClientPath -notmatch '^[a-zA-Z]:[\\/]' -or
    [IO.Path]::GetFileName($ClientPath) -ine 'Weixin.exe') {
    throw 'ClientPath must be the full path of your local official Weixin.exe.'
}
$absolute=[IO.Path]::GetFullPath($ClientPath)
if (!(Test-Path -LiteralPath $absolute -PathType Leaf)) {throw 'Official client not found. Supply -ClientPath.'}
$framework=if([Environment]::Is64BitOperatingSystem){'Framework64'}else{'Framework'}
$compiler=Join-Path $env:windir "Microsoft.NET\$framework\v4.0.30319\csc.exe"
if ((Get-AuthenticodeSignature -LiteralPath $compiler).Status -ne 'Valid') {throw 'Windows framework compiler is unavailable or untrusted.'}
$output=[IO.Directory]::CreateDirectory($OutputDirectory).FullName
$exe=Join-Path $output 'LocalWeixinLauncher.exe'
$work=[IO.Directory]::CreateDirectory((Join-Path $output ([guid]::NewGuid().ToString('N')))).FullName
$binding=Join-Path $work 'ClientBinding.cs'
$build=Join-Path $work 'LocalWeixinLauncher.exe'
$priorTemp=$env:TEMP; $priorTmp=$env:TMP; $priorLib=$env:LIB
try {
    $env:TEMP=$work; $env:TMP=$work; $env:LIB=''
    $line='internal static class ClientBinding { internal const string Path = @"'+$absolute.Replace('"','""')+'"; }'
    [IO.File]::WriteAllText($binding,$line,[Text.UTF8Encoding]::new($true))
    $icon=Join-Path $PSScriptRoot 'assets\LocalWeixinLauncher.ico'
    $extras=@()
    if(Test-Path -LiteralPath $icon -PathType Leaf){$extras+="/win32icon:$icon"}
    $manifest=Join-Path $PSScriptRoot 'app.manifest'
    & $compiler /nologo /target:winexe /optimize+ /platform:anycpu "/out:$build" "/win32manifest:$manifest" @extras /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.dll (Join-Path $PSScriptRoot 'LocalWeixinLauncher.cs') $binding
    if($LASTEXITCODE -ne 0){throw 'Compilation failed.'}
    [IO.File]::Copy($build,$exe,$true)
    Write-Output "Built $exe for $absolute"
} finally {
    $env:TEMP=$priorTemp; $env:TMP=$priorTmp; $env:LIB=$priorLib
    if ([IO.File]::Exists($binding)){[IO.File]::Delete($binding)}
    if ([IO.File]::Exists($build)){[IO.File]::Delete($build)}
    [IO.Directory]::Delete($work)
}
