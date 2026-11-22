$ErrorActionPreference = 'Stop'
# Builds the Windows setup program, build\AutoCutList-setup-<version>.exe, from what Build.cmd put in build\.
# Needs Inno Setup 6 (free): https://jrsoftware.org/isdl.php, or: winget install JRSoftware.InnoSetup
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'build'
$dll = Join-Path $out 'SheetMetalCutList.dll'
$exe = Join-Path $out 'cut-list-settings.exe'
foreach ($path in @($dll, $exe)) {
    if (!(Test-Path -LiteralPath $path)) { throw "Missing $path. Run Build.cmd first." }
}

# One version for everything: the window's (tauri.conf.json) must match the add-in's (AutoCutList.cs).
$version = (Get-Content -Raw (Join-Path $root 'window\tauri.conf.json') | ConvertFrom-Json).version
$source = Get-Content -Raw (Join-Path $root 'addin\AutoCutList.cs')
$match = [regex]::Match($source, 'const string Version = "([^"]+)"')
if (!$match.Success -or $match.Groups[1].Value -ne $version) {
    throw "Version mismatch: tauri.conf.json says $version but AutoCutList.cs says $($match.Groups[1].Value). Make them the same and rebuild."
}

# The setup program installs only the add-in, never SolidWorks' own interop DLLs, so the add-in must have SolidWorks'
# API types built in. Build.ps1 does that unless the compiler can't, in which case it warns.
$referenced = @([Reflection.Assembly]::ReflectionOnlyLoadFrom($dll).GetReferencedAssemblies() |
    Where-Object { $_.Name -like 'SolidWorks.Interop.*' })
if ($referenced.Count -gt 0) {
    throw 'This build references SolidWorks interop DLLs instead of having their types built in (see the warning in build\build.log), so it can''t be packaged.'
}

$compiler = @(
    (Get-Command ISCC.exe -ErrorAction SilentlyContinue | ForEach-Object Source),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (!$compiler) {
    throw 'Inno Setup 6 is not installed. Install it from https://jrsoftware.org/isdl.php (or run: winget install JRSoftware.InnoSetup), then run Package.cmd again.'
}

& $compiler /Q "/DAppVersion=$version" (Join-Path $root 'installer\AutoCutList.iss')
if ($LASTEXITCODE) { throw 'Inno Setup could not build the setup program.' }
$setup = Join-Path $out "AutoCutList-setup-$version.exe"
Write-Host "Built $setup"
