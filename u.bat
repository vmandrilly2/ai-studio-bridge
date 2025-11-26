@echo off
setlocal

cd /d "%~dp0"

set OUT=ai-studio-bridge.vsix

echo Running build and package in PowerShell...
powershell -NoProfile -ExecutionPolicy Bypass -Command "npm run compile; if ($LASTEXITCODE -ne 0) { exit 1 }; if (Test-Path '%OUT%') { Remove-Item -Force '%OUT%' }; npm exec --yes @vscode/vsce package -- --allow-missing-repository --out '%OUT%'; if ($LASTEXITCODE -ne 0) { exit 1 }"
if errorlevel 1 goto :fail

echo Done: "%CD%\%OUT%"
explorer.exe /select,"%CD%\%OUT%"
exit /b 0

:fail
echo ERROR: Packaging failed. See logs above.
exit /b 1
