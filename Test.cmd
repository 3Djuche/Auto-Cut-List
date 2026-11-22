@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Test.ps1" %*
if errorlevel 1 (echo TESTS FAILED) else (echo TESTS PASSED)
pause
