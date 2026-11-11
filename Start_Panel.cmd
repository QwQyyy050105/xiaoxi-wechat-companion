@echo off
setlocal
cd /d "%~dp0" || exit /b 1
where node >nul 2>nul
if errorlevel 1 goto missing_node
where npm.cmd >nul 2>nul
if errorlevel 1 goto missing_node
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exitCode = major < 20 || (major === 20 && minor < 16) ? 1 : 0"
if errorlevel 1 goto missing_node
node -e "require.resolve('./node_modules/qrcode'); require.resolve('./node_modules/json-bigint')" >nul 2>nul
if errorlevel 1 (
  echo Panel dependencies are missing. Open this folder in a terminal and run npm ci --omit=optional first.
  if /i not "%~1"=="--check" pause
  exit /b 1
)
if /i "%~1"=="--check" (
  echo Panel launcher prerequisites passed.
  exit /b 0
)
echo Starting the local configuration panel. Keep this window open; Ctrl+C stops it.
call npm run panel
if errorlevel 1 pause
exit /b %errorlevel%
:missing_node
echo Install Node.js 20.16 or newer, including npm, then reopen this launcher.
if /i not "%~1"=="--check" pause
exit /b 1
