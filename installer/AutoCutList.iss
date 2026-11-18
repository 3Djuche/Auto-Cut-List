; Auto Cut List for SolidWorks: the Windows setup program.
; Built by scripts\Package.ps1 (Package.cmd) with Inno Setup 6 from the files Build.cmd puts in build\.
; Package.ps1 passes the version: /DAppVersion=1.0.0

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define AppName "Auto Cut List"
; The add-in's COM GUID, written with "{{" because a single "{" starts an Inno Setup constant.
#define AddInGuid "{{B0B116CE-FAD5-4B33-9DB0-E1ED77E98884}"
#define RepoUrl "https://github.com/3Djuche/Auto-Cut-List"
#define GuideUrl "https://github.com/3Djuche/Auto-Cut-List/blob/main/docs/user-guide.md"
#define WebView2Url "https://developer.microsoft.com/microsoft-edge/webview2/"

[Setup]
; Never change AppId: Windows uses it to recognize upgrades and the uninstaller.
AppId={{6168638E-E247-4554-AF07-E590D719956E}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=3Djuche
AppPublisherURL={#RepoUrl}
AppSupportURL={#RepoUrl}/issues
AppUpdatesURL={#RepoUrl}/releases
; The same folder Install.cmd used, so installing over a script install upgrades it in place.
DefaultDirName={autopf}\Auto Cut List for SolidWorks
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
; SolidWorks is 64-bit only, and so is the add-in.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
SetupIconFile=..\icons\app\icon.ico
UninstallDisplayIcon={app}\cut-list-settings.exe
UninstallDisplayName={#AppName} for SolidWorks
OutputDir=..\build
OutputBaseFilename=AutoCutList-setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
; Upgrading while SolidWorks has the add-in loaded: offer to close it rather than fail on a locked file.
CloseApplications=yes
RestartApplications=no
; The "load when SolidWorks starts" choice is a per-user SolidWorks setting.
UsedUserAreasWarning=no
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}

[Tasks]
Name: "startup"; Description: "Load Auto Cut List every time SolidWorks starts"

[InstallDelete]
; An install made under the add-in's old name, Sheet Metal Cut List. Registering this copy takes over its registration.
Type: filesandordirs; Name: "{commonpf64}\Sheet Metal Cut List for SolidWorks"
; SolidWorks interop DLLs left by earlier script installs; this build has SolidWorks' API types built in.
Type: files; Name: "{app}\SolidWorks.Interop.*.dll"

[Files]
Source: "..\build\SheetMetalCutList.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\build\cut-list-settings.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\icons\addin\*.png"; DestDir: "{app}\icons"; Flags: ignoreversion
Source: "..\LICENSE-MIT"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE-APACHE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\docs\ICON-CREDITS.md"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
; Loads the add-in at SolidWorks start-up, the same as checking Start Up in Tools > Add-Ins.
Root: HKCU; Subkey: "Software\SolidWorks\AddInsStartup\{#AddInGuid}"; ValueType: dword; ValueName: ""; ValueData: 1; Tasks: startup; Flags: uninsdeletekey

[Icons]
Name: "{group}\Auto Cut List user guide"; Filename: "{#GuideUrl}"
Name: "{group}\Uninstall Auto Cut List"; Filename: "{uninstallexe}"

[Run]
Filename: "{#GuideUrl}"; Description: "Open the user guide"; Flags: postinstall shellexec skipifsilent unchecked nowait

[Messages]
FinishedLabel=Auto Cut List is installed. Open SolidWorks and choose Tools > Auto Cut List > Label Cut List.%n%nIf it isn't there, check Auto Cut List under Tools > Add-Ins.

[Code]
const
  WebView2Client = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function SolidWorksRunning(): Boolean;
var
  Locator, Service, Found: Variant;
begin
  Result := False;
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('.', 'root\CIMV2');
    Found := Service.ExecQuery('SELECT ProcessId FROM Win32_Process WHERE Name = ''SLDWORKS.exe''');
    Result := Found.Count > 0;
  except
    // If Windows can't say, carry on: a locked file is still caught when files are copied.
  end;
end;

// Asks the user to close SolidWorks until they do, or cancel.
function SolidWorksClosed(Action: String): Boolean;
begin
  Result := True;
  while SolidWorksRunning() do
    if SuppressibleMsgBox('SolidWorks is running. Save your work and close SolidWorks, then click Retry to continue ' + Action + '.',
        mbError, MB_RETRYCANCEL, IDCANCEL) <> IDRETRY then
    begin
      Result := False;
      Exit;
    end;
end;

// Microsoft's documented check: the runtime records its version ("pv") under EdgeUpdate\Clients.
function HasWebView2(): Boolean;
var
  Version: String;
begin
  Result :=
    (RegQueryStringValue(HKLM32, 'SOFTWARE\' + WebView2Client, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0')) or
    (RegQueryStringValue(HKLM64, 'SOFTWARE\' + WebView2Client, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, 'Software\' + WebView2Client, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0'));
end;

function InitializeSetup(): Boolean;
var
  ErrorCode: Integer;
begin
  Result := SolidWorksClosed('installing');
  if Result and not HasWebView2() then
    case SuppressibleMsgBox('Auto Cut List''s window needs the Microsoft Edge WebView2 Runtime, which isn''t installed on this PC.' + #13#10#13#10 +
        'Click Yes to open Microsoft''s download page (install the Evergreen Runtime, then run this setup again), ' +
        'No to install anyway, or Cancel to stop.', mbConfirmation, MB_YESNOCANCEL, IDNO) of
      IDYES:
        begin
          ShellExec('open', '{#WebView2Url}', '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
          Result := False;
        end;
      IDCANCEL: Result := False;
    end;
end;

function RegAsm(): String;
begin
  Result := ExpandConstant('{dotnet4064}\RegAsm.exe');
end;

// Registers the add-in with Windows (COM), which is how SolidWorks finds it.
procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if CurStep = ssPostInstall then
    if not Exec(RegAsm(), '"' + ExpandConstant('{app}\SheetMetalCutList.dll') + '" /codebase /silent', '', SW_HIDE,
        ewWaitUntilTerminated, Code) or (Code <> 0) then
      SuppressibleMsgBox('Auto Cut List was copied, but registering it with SolidWorks failed (code ' + IntToStr(Code) + '). ' +
        'Make sure the .NET Framework 4.8 is installed, then run this setup again.', mbError, MB_OK, IDOK);
end;

function InitializeUninstall(): Boolean;
begin
  Result := SolidWorksClosed('uninstalling');
end;

// Unregisters before the files are removed. This also removes the add-in from Tools > Add-Ins.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
begin
  if CurUninstallStep = usUninstall then
    Exec(RegAsm(), '"' + ExpandConstant('{app}\SheetMetalCutList.dll') + '" /unregister /silent', '', SW_HIDE,
      ewWaitUntilTerminated, Code);
end;
