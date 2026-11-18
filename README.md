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

1. Extract the ZIP, save any open work, and close SolidWorks.
2. Double-click **Install.cmd** and approve the administrator prompt. The installer window stays open so you can read the result.
   - If SolidWorks is installed somewhere other than `C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS`, open 64-bit PowerShell as Administrator in the extracted folder and run `.\scripts\Install.ps1 -SolidWorksDirectory "<your SolidWorks folder>"`.
3. Start SolidWorks, open **Tools > Add-Ins**, and check **Auto Cut List** under Active Add-ins. Check **Start Up** as well to load it every time SolidWorks starts.

The add-in is installed to `C:\Program Files\Auto Cut List for SolidWorks`. If an earlier version is installed under its old name, Sheet Metal Cut List, the installer replaces it and your settings are kept. To upgrade, close SolidWorks and run Install.cmd from the new package; it replaces the previous version.

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

Either way, this builds `SheetMetalCutList.dll` and `cut-list-settings.exe` into the `build` folder (Build.cmd also saves its output to `build\build.log`). Pass `-SolidWorksDirectory` if SolidWorks is not in the default folder. Then run Install.cmd.

SolidWorks' API types are built into `SheetMetalCutList.dll`, so it doesn't depend on one SolidWorks version's interop DLLs. If the compiler can't do that, Build warns and references them instead, and Install.ps1 copies just the ones the add-in needs.

**Repository layout.**

| Folder | What's in it |
|---|---|
| (top) | `Build.cmd`, `Install.cmd`, `Test.cmd` (double-click these) and this README |
| `addin/` | The SolidWorks add-in (`AutoCutList.cs`, built as `SheetMetalCutList.dll`, the name SolidWorks registered it under) |
| `window/` | The settings window: the Tauri program (`src/`, `Cargo.toml`, `tauri.conf.json`) and its page (`ui/`) |
| `icons/window/` | The window's icons (toolbar, categories, shapes, busy pointer) |
| `icons/app/` | The program icon: `auto-cut-list.png` (master artwork) and `icon.ico` (window and .exe). Regenerate the ICO and add-in PNG sizes with `scripts/Generate-Icons.ps1`. |
| `icons/addin/` | The program icon as PNGs for the SolidWorks menu and Add-Ins list |
| `scripts/` | The PowerShell scripts the .cmd files run |
| `tests/` | Add-in and window tests |
| `docs/` | The user guide (`user-guide.md`) and its screenshots (`images/`), and `ICON-CREDITS.md`, where the third-party icons' sources and licenses are recorded |
| `build/` | Everything Build makes (not in git) |

**Icons.** Edit the window's icons in `icons/window`. Build copies them into `window/ui/icons`, which is build output (the window can only load files from `window/ui`), and makes the 32 px busy pointer from `loading.svg`.

## Tests

Double-click **Test.cmd** (or run `.\scripts\Test.ps1`) after building. Neither set of tests needs SolidWorks.

- **Add-in tests** (`tests/AddInTests.cs`): compiled with the same .NET Framework compiler and run against `build\SheetMetalCutList.dll`. They cover the add-in's logic that doesn't need SolidWorks: reading lengths, rounding, matching exact flat-pattern sizes to SolidWorks' rounded values, the out-of-date comparison, the body-fitting geometry, request numbering in replies, and which requests save settings.
- **Window tests** (`tests/*.test.js`): the settings window against a simulated add-in. They need [Node.js](https://nodejs.org) 20 or later and are skipped without it. To run them on their own: `cd tests`, `npm install`, `npm test`.

What only SolidWorks can do (measuring bodies, writing properties, switching configurations, events) is checked in SolidWorks.

## Uninstall

Close SolidWorks, open 64-bit PowerShell as Administrator in the extracted folder, and run:

```powershell
.\scripts\Install.ps1 -Uninstall
```

## Credits

Third-party icons, with their sources and licenses, are listed in `docs/ICON-CREDITS.md`.
