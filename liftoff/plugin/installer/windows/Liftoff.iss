; Windows installer for Liftoff (Inno Setup 6).
; Puts the VST3 in C:\Program Files\Common Files\VST3, where every DAW looks, and the app in Program Files with a Start menu entry.
; Built in CI with: ISCC /DAppVer=0.1.0 installer\windows\Liftoff.iss
#ifndef AppVer
  #define AppVer "0.0.0"
#endif

[Setup]
AppId={{3F1C9A57-2D4E-4B8A-A6C3-9E7D51B2C804}
AppName=Liftoff
AppVersion={#AppVer}
AppVerName=Liftoff {#AppVer}
AppPublisher=cool_projects404
DefaultDirName={autopf}\Liftoff
DisableProgramGroupPage=yes
DisableDirPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
OutputDir=..\..\dist
OutputBaseFilename=Liftoff-Windows-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Liftoff
UninstallDisplayIcon={app}\Liftoff.exe
CloseApplications=yes

[Files]
Source: "..\..\dist\Liftoff-Windows\Liftoff.vst3\*"; DestDir: "{commoncf64}\VST3\Liftoff.vst3"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\..\dist\Liftoff-Windows\Liftoff.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\Liftoff-Windows\INSTALL.md"; DestDir: "{app}"; Flags: ignoreversion

[InstallDelete]
; an older manual copy in the same place is replaced cleanly
Type: filesandordirs; Name: "{commoncf64}\VST3\Liftoff.vst3"

[Icons]
Name: "{autoprograms}\Liftoff"; Filename: "{app}\Liftoff.exe"

[Messages]
FinishedLabel=Liftoff is installed.%n%nOpen your DAW, rescan plugins if it asks (FL Studio: Options > Manage plugins > Find plugins), and put Liftoff on a track, a bus or the master.
