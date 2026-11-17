#Requires -RunAsAdministrator
param(
    [switch]$Uninstall,
    [string]$SolidWorksDirectory = 'C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS'
)

$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitProcess) { throw 'Run this script from 64-bit PowerShell.' }
if (Get-Process SLDWORKS -ErrorAction SilentlyContinue) {
    throw 'Save your work and close SolidWorks before installing or uninstalling.'
}

$destination = Join-Path $env:ProgramFiles 'Auto Cut List for SolidWorks'
# Earlier versions were installed under the add-in's old name.
$oldDestination = Join-Path $env:ProgramFiles 'Sheet Metal Cut List for SolidWorks'
$dll = Join-Path $destination 'SheetMetalCutList.dll'
$regAsm = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe'
$uiName = 'cut-list-settings.exe'
$interop = @('sldworks', 'swconst', 'swpublished') | ForEach-Object { "SolidWorks.Interop.$_.dll" }

if ($Uninstall) {
    $registered = @($dll, (Join-Path $oldDestination 'SheetMetalCutList.dll')) |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($registered) {
        & $regAsm $registered /unregister
        if ($LASTEXITCODE -ne 0) { throw "Unregistration failed ($LASTEXITCODE)." }
    }
    foreach ($folder in @($destination, $oldDestination)) {
        $iconFolder = Join-Path $folder 'icons'
        if (Test-Path -LiteralPath $iconFolder) {
            Get-ChildItem -LiteralPath $iconFolder -Filter 'auto-cut-list_*.png' -File | Remove-Item
            if (-not (Get-ChildItem -LiteralPath $iconFolder -Force)) { Remove-Item -LiteralPath $iconFolder }
        }
        foreach ($name in ($interop + $uiName + 'SheetMetalCutList.dll')) {
            $path = Join-Path $folder $name
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
        }
        if ((Test-Path -LiteralPath $folder) -and -not (Get-ChildItem -LiteralPath $folder -Force)) { Remove-Item -LiteralPath $folder }
    }
    Write-Host 'Auto Cut List was uninstalled.'
    return
}

# Installs what Build.cmd put in build\, and the menu icons from icons\addin.
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'build\SheetMetalCutList.dll'
$ui = Join-Path $root "build\$uiName"
foreach ($path in @($source, $ui, $regAsm)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required file missing: $path (run Build.cmd first)" }
}
# Normally the add-in has SolidWorks' API types built in and needs no interop DLLs. If Build.ps1 had to reference
# them instead, copy just the ones it references; stale copies left by earlier installs are removed below.
$referenced = @([Reflection.Assembly]::ReflectionOnlyLoadFrom($source).GetReferencedAssemblies() |
    Where-Object { $_.Name -like 'SolidWorks.Interop.*' } | ForEach-Object { "$($_.Name).dll" })
$dependencies = @($referenced | ForEach-Object { Join-Path $SolidWorksDirectory $_ })
foreach ($path in $dependencies) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required file missing: $path" }
}

$iconSource = Join-Path $root 'icons\addin'
$icons = @(Get-ChildItem -LiteralPath $iconSource -Filter '*.png' -File -ErrorAction SilentlyContinue)
if ($icons.Count -eq 0) { throw "Required files missing: the add-in icons in $iconSource" }

# Replace an install made under the old name. Registering the new copy below takes over the add-in's
# registration, so its Add-Ins and Start Up settings in SolidWorks are kept.
if (Test-Path -LiteralPath $oldDestination) {
    foreach ($name in ($interop + $uiName + 'SheetMetalCutList.dll')) {
        $path = Join-Path $oldDestination $name
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
    }
    if (-not (Get-ChildItem -LiteralPath $oldDestination -Force)) { Remove-Item -LiteralPath $oldDestination }
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($name in $interop) {
    $path = Join-Path $destination $name
    if (($referenced -notcontains $name) -and (Test-Path -LiteralPath $path)) { Remove-Item -LiteralPath $path }
}
Copy-Item -LiteralPath (@($source, $ui) + $dependencies) -Destination $destination -Force
$iconDestination = Join-Path $destination 'icons'
New-Item -ItemType Directory -Path $iconDestination -Force | Out-Null
Copy-Item -LiteralPath $icons.FullName -Destination $iconDestination -Force
# Files extracted from a downloaded ZIP carry a "blocked" mark that can stop SolidWorks loading them.
Get-ChildItem -LiteralPath $destination -File -Recurse | Unblock-File
& $regAsm $dll /codebase
if ($LASTEXITCODE -ne 0) { throw "Registration failed ($LASTEXITCODE)." }
Write-Host 'Installed. Open SolidWorks and enable Auto Cut List in Tools > Add-Ins.'

