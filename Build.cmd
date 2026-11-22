@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0build" mkdir "%~dp0build"
echo Building Auto Cut List. This can take several minutes...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Build.ps1" %* > "%~dp0build\build.log" 2>&1
if errorlevel 1 (echo BUILD FAILED>>"%~dp0build\build.log") else (echo BUILD SUCCEEDED>>"%~dp0build\build.log")
type "%~dp0build\build.log"
pause
