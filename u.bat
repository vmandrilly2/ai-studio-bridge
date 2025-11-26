@echo off
setlocal

cd /d "%~dp0"
set ROOTDIR=%CD%

set OUT=ai-studio-bridge.vsix
set PACKDIR=%TEMP%\ai-studio-bridge-pack

echo Running build and package in PowerShell...
if not exist "node_modules\typescript\package.json" (
  echo Restoring dev dependencies...
  call npm install --include=dev --no-audit --no-fund
  if errorlevel 1 goto :fail
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "npm run compile; if ($LASTEXITCODE -ne 0) { exit 1 }"
if errorlevel 1 goto :fail

if exist "%PACKDIR%" rmdir /s /q "%PACKDIR%"
mkdir "%PACKDIR%"

copy /y "package.json" "%PACKDIR%\package.json" >nul
if exist "package-lock.json" copy /y "package-lock.json" "%PACKDIR%\package-lock.json" >nul
if exist "README.md" copy /y "README.md" "%PACKDIR%\README.md" >nul
if exist "readme.md" copy /y "readme.md" "%PACKDIR%\readme.md" >nul
if exist "CHANGELOG.md" copy /y "CHANGELOG.md" "%PACKDIR%\changelog.md" >nul
if exist "LICENSE" copy /y "LICENSE" "%PACKDIR%\LICENSE.txt" >nul
if exist ".vscodeignore" copy /y ".vscodeignore" "%PACKDIR%\.vscodeignore" >nul
if exist "AI Studio --- VS Code Bridge-1.1.user.js" copy /y "AI Studio --- VS Code Bridge-1.1.user.js" "%PACKDIR%\AI Studio --- VS Code Bridge-1.1.user.js" >nul

xcopy /e /i /y "out" "%PACKDIR%\out" >nul

pushd "%PACKDIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-Content 'package.json' | ConvertFrom-Json; $p.PSObject.Properties.Remove('scripts'); $p.PSObject.Properties.Remove('devDependencies'); ($p | ConvertTo-Json -Depth 100) | Set-Content 'package.json'"
if errorlevel 1 (popd & goto :fail)

call npm ci --omit=dev --no-audit --no-fund
if errorlevel 1 (popd & goto :fail)

powershell -NoProfile -ExecutionPolicy Bypass -Command "npm exec --yes @vscode/vsce package -- --allow-missing-repository --out '%PACKDIR%\\%OUT%'; if ($LASTEXITCODE -ne 0) { exit 1 }"
set PKG_RC=%ERRORLEVEL%
popd
if not %PKG_RC%==0 goto :fail

copy /y "%PACKDIR%\%OUT%" "%ROOTDIR%\%OUT%" >nul
echo Done: "%ROOTDIR%\%OUT%"
explorer.exe /select,"%ROOTDIR%\%OUT%"
exit /b 0

:fail
echo ERROR: Packaging failed. See logs above.
exit /b 1
