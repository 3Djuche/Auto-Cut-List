# Auto-Cut-List

A SolidWorks add-in that fills in the **Description** and **Length** properties of every cut-list item in a part, using templates you control.

It sorts each cut-list item into one of three categories — **Sheet Metal**, **Weldment** or **Regular Part** — measures it, and builds its labels from that category's templates. You review every change before anything is written to the part.

**[Read the user guide](docs/user-guide.md)** for everything the add-in does: templates, weldment shapes, gauges, labeling several parts, exports and settings.

## Requirements

- 64-bit SolidWorks 2026
- Windows with the [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (already included in Windows 11)
- Microsoft Excel, only for **Export to Excel** and **Export to PDF**

The installer uses the SolidWorks API libraries from your own SolidWorks installation.

## Install

1. Download **AutoCutList-setup-<version>.exe** from the [latest release](https://github.com/3Djuche/Auto-Cut-List/releases/latest).
2. Save your work and close SolidWorks, then run the setup program and approve the administrator prompt. The files aren't code-signed, so Windows SmartScreen may warn about an unrecognized app; choose **More info > Run anyway**.
3. Leave **Load Auto Cut List every time SolidWorks starts** checked (or check **Auto Cut List** under **Tools > Add-Ins** later).
4. Open SolidWorks and choose **Tools > Auto Cut List > Label Cut List**.

The add-in is installed to `C:\Program Files\Auto Cut List for SolidWorks`. Installing needs administrator rights; where users don't have them, IT can install it silently with `AutoCutList-setup-<version>.exe /VERYSILENT`. To upgrade, run the new version's setup program; your templates and presets are kept. An earlier version installed with Install.cmd, or under the add-in's old name, Sheet Metal Cut List, is replaced.

To uninstall, close SolidWorks and remove **Auto Cut List** under Windows **Settings > Apps > Installed apps**. Your templates and presets stay in your Windows profile, ready for a reinstall.

## Quick start

1. Choose **Tools > Auto Cut List > Label Cut List**. If no part is active, open one and click **Refresh**.
2. Check the labels the templates propose. Labels that would change are shown in blue, with the current value struck through underneath.
3. Edit a category's templates in the **Templates** bar at the bottom; the table updates as you type.
4. Check the items to write and click **Apply**.
5. Save the part to keep the labels.

Nothing is written to the part until you click Apply. See the [user guide](docs/user-guide.md) for the rest.

## Build from source

Requirements: the .NET Framework 4 C# compiler (included with Windows), an x64 Rust MSVC toolchain with the Microsoft C++ Build Tools and Windows SDK, and SolidWorks installed.

From the repository folder, double-click **Build.cmd**, or run:

```powershell
.\scripts\Build.ps1
```

Either way, this builds `SheetMetalCutList.dll` and `cut-list-settings.exe` into the `build` folder (Build.cmd also saves its output to `build\build.log`). Pass `-SolidWorksDirectory` if SolidWorks is not in the default folder.

To try a build on your own PC, run **Install.cmd** (it installs straight from `build`; `.\scripts\Install.ps1 -Uninstall` from an administrator PowerShell removes it). To make the setup program for a release, install [Inno Setup 6](https://jrsoftware.org/isdl.php) (`winget install JRSoftware.InnoSetup`) and double-click **Package.cmd**: it builds `build\AutoCutList-setup-<version>.exe` from the latest build. The version comes from `window/tauri.conf.json` and must match `Version` in `addin/AutoCutList.cs`.

SolidWorks' API types are built into `SheetMetalCutList.dll`, so it doesn't depend on one SolidWorks version's interop DLLs. If the compiler can't do that, Build warns and references them instead, and Install.ps1 copies just the ones the add-in needs. Package.cmd refuses such a build, since the setup program never includes SolidWorks' own files.

**Repository layout.**

| Folder | What's in it |
|---|---|
| (top) | `Build.cmd`, `Test.cmd`, `Install.cmd` and `Package.cmd` (double-click these) and this README |
| `addin/` | The SolidWorks add-in (`AutoCutList.cs`, with request and data classes in `Contracts/` Win32 calls in `Process/`, solid-body box fitting in `Geometry/`, the Excel/PDF export in `Export/`, saved settings and presets in `Settings/`, reading and measuring parts in `Reading/`, writing labels, undo and tree order in `Writing/`, the stale-label warnings in `Watching/`, and the link to the settings window in `Session/`; built as `SheetMetalCutList.dll`, the name SolidWorks registered it under) |
| `window/` | The settings window: the Tauri program (`src/`, `Cargo.toml`, `tauri.conf.json`) and its page (`ui/`: `index.html`, `style.css`, and the page's scripts in `ui/scripts/`: JavaScript modules, started from `main.js`) |
| `icons/window/` | The window's icons (toolbar, categories, shapes, busy pointer) |
| `icons/app/` | The program icon: `auto-cut-list.png` (master artwork) and `icon.ico` (window and .exe). Regenerate the ICO and add-in PNG sizes with `scripts/Generate-Icons.ps1`. |
| `icons/addin/` | The program icon as PNGs for the SolidWorks menu and Add-Ins list |
| `scripts/` | The PowerShell scripts the .cmd files run |
| `installer/` | The Inno Setup script for the setup program (`AutoCutList.iss`) |
| `tests/` | Add-in and window tests |
| `docs/` | The user guide (`user-guide.md`) and its screenshots (`images/`), the [architecture overview](docs/architecture.md) (`architecture.md`: how the add-in and the window fit together, and what each file does), and `ICON-CREDITS.md`, where the third-party icons' sources and licenses are recorded |
| `build/` | Everything Build makes (not in git) |

**Icons.** Edit the window's icons in `icons/window`. Build copies them into `window/ui/icons`, which is build output (the window can only load files from `window/ui`), and makes the 32 px busy pointer from `loading.svg`.

## Tests

Double-click **Test.cmd** (or run `.\scripts\Test.ps1`) after building. Neither set of tests needs SolidWorks.

- **Add-in tests** (`tests/AddInTests.cs`): compiled with the same .NET Framework compiler and run against `build\SheetMetalCutList.dll`. They cover the add-in's logic that doesn't need SolidWorks: reading lengths, rounding, matching exact flat-pattern sizes to SolidWorks' rounded values, the out-of-date comparison, the body-fitting geometry, request numbering in replies, and which requests save settings.
- **Window tests** (`tests/*.test.js`): the settings window against a simulated add-in. They need [Node.js](https://nodejs.org) 20 or later and are skipped without it. To run them on their own: `cd tests`, `npm install`, `npm test`.

What only SolidWorks can do (measuring bodies, writing properties, switching configurations, events) is checked in SolidWorks.

## Credits

Third-party icons, with their sources and licenses, are listed in `docs/ICON-CREDITS.md`.

## License

Auto Cut List is licensed under either of

- the [MIT License](LICENSE-MIT), or
- the [Apache License, Version 2.0](LICENSE-APACHE)

at your option.

Unless you explicitly state otherwise, any contribution you submit for inclusion in this project, as defined in the Apache-2.0 license, is dual licensed as above, without any additional terms or conditions.

The third-party icons in `icons/window` are not covered by this license; each keeps the license of its source, listed in `docs/ICON-CREDITS.md`.
