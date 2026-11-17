param([string]$SolidWorksDirectory = 'C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS')
$ErrorActionPreference = 'Stop'
# Runs the add-in's tests (tests\AddInTests.cs, against the build\SheetMetalCutList.dll that Build.cmd made) and, when
# Node.js is installed, the settings window's tests. Neither needs SolidWorks to be running.
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$root = Split-Path -Parent $PSScriptRoot
$dll = Join-Path $root 'build\SheetMetalCutList.dll'
if (!(Test-Path -LiteralPath $dll)) { throw 'Build the add-in first: run Build.cmd.' }
$bin = Join-Path $root 'build\tests'
New-Item -ItemType Directory -Path $bin -Force | Out-Null
Copy-Item -LiteralPath $dll -Destination $bin -Force
# Only needed if Build.ps1 had to reference SolidWorks' interop DLLs instead of building them in.
foreach ($name in 'sldworks', 'swconst', 'swpublished') {
    $file = Join-Path $SolidWorksDirectory "SolidWorks.Interop.$name.dll"
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination $bin -Force }
}
$exe = Join-Path $bin 'AddInTests.exe'
& $compiler /nologo /platform:x64 "/out:$exe" (Join-Path $root 'tests\AddInTests.cs')
if ($LASTEXITCODE) { throw 'The add-in tests could not be compiled.' }
& $exe (Join-Path $bin 'SheetMetalCutList.dll')
$failed = [int]($LASTEXITCODE -ne 0)

if (Get-Command npm -ErrorAction SilentlyContinue) {
    Push-Location (Join-Path $root 'tests')
    try {
        if (!(Test-Path -LiteralPath 'node_modules')) { npm install --silent }
        npm test
        if ($LASTEXITCODE) { $failed = 1 }
    }
    finally { Pop-Location }
}
else { Write-Host 'Node.js is not installed, so the settings window tests were skipped.' }
if ($failed) { throw 'Some tests failed.' }
Write-Host 'All tests passed.'
