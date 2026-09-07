#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

#ifndef AppVersionInfo
  #define AppVersionInfo "0.0.0.0"
#endif

#ifndef RepoRoot
  #define RepoRoot ".."
#endif

#ifndef SourceDir
  #define SourceDir "..\dist\win"
#endif

#ifndef OutputDir
  #define OutputDir "..\dist\release"
#endif

[Setup]
AppId={{6C431F21-C954-4300-A296-3374C1C21A86}
AppName=inpx-web
AppVersion={#AppVersion}
AppPublisher=AceAsket
AppPublisherURL=https://github.com/AceAsket/inpx-web
AppSupportURL=https://github.com/AceAsket/inpx-web/issues
AppUpdatesURL=https://github.com/AceAsket/inpx-web/releases/latest
DefaultDirName={localappdata}\Programs\inpx-web
DefaultGroupName=inpx-web
AllowNoIcons=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=inpx-web-{#AppVersion}-win-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#RepoRoot}\client\assets\favicon.ico
LicenseFile={#RepoRoot}\LICENSE.md
UninstallDisplayIcon={app}\inpx-web.exe
VersionInfoVersion={#AppVersionInfo}
VersionInfoCompany=AceAsket
VersionInfoDescription=inpx-web Windows installer
VersionInfoProductName=inpx-web
VersionInfoProductVersion={#AppVersionInfo}
VersionInfoProductTextVersion={#AppVersion}

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\inpx-web.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\readme.html"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "{#SourceDir}\bin\*"; DestDir: "{app}\bin"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist
Source: "{#RepoRoot}\LICENSE.md"; DestDir: "{app}"; Flags: ignoreversion

[INI]
Filename: "{app}\inpx-web.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://127.0.0.1:12380"
Filename: "{app}\inpx-web.url"; Section: "InternetShortcut"; Key: "IconFile"; String: "{app}\inpx-web.exe"
Filename: "{app}\inpx-web.url"; Section: "InternetShortcut"; Key: "IconIndex"; String: "0"

[Icons]
Name: "{group}\inpx-web"; Filename: "{app}\inpx-web.exe"; Parameters: "--data-dir=""{localappdata}\inpx-web"""; WorkingDir: "{app}"
Name: "{group}\Open web interface"; Filename: "{app}\inpx-web.url"; WorkingDir: "{app}"
Name: "{group}\README"; Filename: "{app}\readme.html"; WorkingDir: "{app}"; Check: FileExists(ExpandConstant('{app}\readme.html'))
Name: "{group}\Uninstall inpx-web"; Filename: "{uninstallexe}"
Name: "{autodesktop}\inpx-web"; Filename: "{app}\inpx-web.exe"; Parameters: "--data-dir=""{localappdata}\inpx-web"""; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\inpx-web.exe"; Parameters: "--data-dir=""{localappdata}\inpx-web"""; Description: "{cm:LaunchProgram,inpx-web}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: files; Name: "{app}\inpx-web.url"
