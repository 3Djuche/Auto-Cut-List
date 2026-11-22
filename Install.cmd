@echo off
setlocal
set "SW_CUTLIST_INSTALL=%~dp0scripts\Install.ps1"
powershell.exe -NoProfile -Command "try { Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -NoExit -File ' + [char]34 + $env:SW_CUTLIST_INSTALL + [char]34) -ErrorAction Stop } catch { Write-Error $_; exit 1 }"
if errorlevel 1 pause
