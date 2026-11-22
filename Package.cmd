@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0build" mkdir "%~dp0build"
echo Building the Auto Cut List setup program...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Package.ps1" %* > "%~dp0build\package.log" 2>&1
if errorlevel 1 (echo PACKAGE FAILED>>"%~dp0build\package.log") else (echo PACKAGE SUCCEEDED>>"%~dp0build\package.log")
type "%~dp0build\package.log"
pause
