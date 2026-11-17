param([string]$SolidWorksDirectory = 'C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS')
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$interop = foreach ($name in 'sldworks','swconst','swpublished') {
    $file = Join-Path $SolidWorksDirectory "SolidWorks.Interop.$name.dll"
    if (!(Test-Path -LiteralPath $file)) { throw "SolidWorks API library missing: $file" }
    $file
}
# Everything Build makes goes in build\: the add-in DLL, the window's .exe, build.log and Rust's build cache.
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'build'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$ui = Join-Path $root 'window'
$source = Join-Path $root 'addin\AutoCutList.cs'
# The DLL keeps its original name: SolidWorks registered the add-in under it.
$dll = Join-Path $out 'SheetMetalCutList.dll'
$common = @('/nologo', '/target:library', '/platform:x64', '/optimize+', "/out:$dll",
    '/reference:System.Web.Extensions.dll', '/reference:System.Windows.Forms.dll', '/reference:Microsoft.CSharp.dll')
# Build SolidWorks' API types into the add-in (/link), so it doesn't depend on one SolidWorks version's interop
# DLLs and keeps working after a SolidWorks upgrade. If this compiler can't, fall back to referencing them; the
# installer then copies the ones the add-in needs next to it.
& $compiler @common ($interop | ForEach-Object { "/link:$_" }) $source
if ($LASTEXITCODE) {
    Write-Warning 'Could not build the SolidWorks API types into the add-in; referencing the interop DLLs instead.'
    & $compiler @common ($interop | ForEach-Object { "/reference:$_" }) $source
    if ($LASTEXITCODE) { throw 'SolidWorks add-in compilation failed.' }
}
# The window's icons are edited in icons\window. The window can only load files from window\ui, so they're
# copied into window\ui\icons for each build (that folder is build output, emptied first so removed icons don't
# linger). The busy pointer is the loading icon at 32 px, the size Windows uses for pointers.
$iconSource = Join-Path $root 'icons\window'
$iconTarget = Join-Path $ui 'ui\icons'
if (Test-Path -LiteralPath $iconTarget) { Remove-Item -LiteralPath $iconTarget -Recurse -Force }
New-Item -ItemType Directory -Path $iconTarget -Force | Out-Null
foreach ($name in 'settings', 'xlsx', 'pdf', 'refresh-data', 'diameter-symbol', 'warning', 'padlock', 'all',
        'sheet-metal', 'weldment', 'folder',
        'square-tube', 'rectangular-tube', 'round-tube', 'pipe', 'i-beam', 'c-channel', 'angle', 'tee-bar',
        'flat-bar', 'square-bar', 'round-bar') {
    Copy-Item -LiteralPath (Join-Path $iconSource "$name.svg") -Destination $iconTarget -Force
}
$loading = [IO.File]::ReadAllText((Join-Path $iconSource 'loading.svg'))
$loading = ([regex]'(<svg\b[^>]*?\s)width="[^"]*"').Replace($loading, '${1}width="32"', 1)
$loading = ([regex]'(<svg\b[^>]*?\s)height="[^"]*"').Replace($loading, '${1}height="32"', 1)
[IO.File]::WriteAllText((Join-Path $iconTarget 'loading-cursor.svg'), $loading, (New-Object Text.UTF8Encoding($false)))

$target = Join-Path $out 'target'
cargo build --locked --release --manifest-path (Join-Path $ui 'Cargo.toml') --target-dir $target
if ($LASTEXITCODE) { throw 'Tauri build failed.' }
Copy-Item -LiteralPath (Join-Path $target 'release/cut-list-settings.exe') -Destination $out -Force
