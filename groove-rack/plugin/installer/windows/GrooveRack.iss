; Windows installer for Groove Rack (Inno Setup 6).
; Puts the VST3 in C:\Program Files\Common Files\VST3, where every DAW looks, and the app in Program Files with a Start menu entry.
; Built in CI with: ISCC /DAppVer=0.2.2 installer\windows\GrooveRack.iss
#ifndef AppVer
  #define AppVer "0.0.0"
#endif

[Setup]
AppId={{8B4E2C61-6E0B-4C7B-9C1E-47A1D3B5F0A2}
AppName=Groove Rack
AppVersion={#AppVer}
AppVerName=Groove Rack {#AppVer}
AppPublisher=cool_projects404
DefaultDirName={autopf}\Groove Rack
DisableProgramGroupPage=yes
DisableDirPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
OutputDir=..\..\dist
OutputBaseFilename=GrooveRack-Windows-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Groove Rack
UninstallDisplayIcon={app}\Groove Rack.exe
CloseApplications=yes

[Files]
Source: "..\..\dist\GrooveRack-Windows\Groove Rack.vst3\*"; DestDir: "{commoncf64}\VST3\Groove Rack.vst3"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\..\dist\GrooveRack-Windows\Groove Rack.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\GrooveRack-Windows\INSTALL.md"; DestDir: "{app}"; Flags: ignoreversion

[InstallDelete]
; an older manual copy in the same place is replaced cleanly
Type: filesandordirs; Name: "{commoncf64}\VST3\Groove Rack.vst3"

[Icons]
Name: "{autoprograms}\Groove Rack"; Filename: "{app}\Groove Rack.exe"

[Messages]
FinishedLabel=Groove Rack is installed.%n%nOpen your DAW, rescan plugins if it asks (FL Studio: Options > Manage plugins > Find plugins), and load Groove Rack as an instrument. You can also open the Groove Rack app from the Start menu.

[Run]
Filename: "{app}\Groove Rack.exe"; Description: "Open the Groove Rack app now"; Flags: postinstall nowait skipifsilent unchecked
