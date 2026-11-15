; makensis -DSTAGE=/absolute/staged-package -DOUTFILE=/absolute/Setup.exe
; Single-user installation. Uninstall only removes manifest-listed files.
Unicode true
Target amd64-unicode
!include MUI2.nsh
!include LogicLib.nsh
!include x64.nsh
!include WinVer.nsh
!include FileFunc.nsh
!ifndef STAGE
!error "Define STAGE"
!endif
!ifndef OUTFILE
!error "Define OUTFILE"
!endif
!ifndef UNINSTALL_LIST
!error "Define UNINSTALL_LIST"
!endif

Name "SpektraLab Windows 1.3.3-lighttable.3 (build 13304)"
OutFile "${OUTFILE}"
InstallDir "E:\SpektraLab"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32
VIProductVersion "1.3.3.4"
VIAddVersionKey /LANG=1033 "ProductName" "SpektraLab Windows"
VIAddVersionKey /LANG=1033 "FileDescription" "SpektraLab Windows 1.3.3-lighttable.3 build 13304 installer"
VIAddVersionKey /LANG=1033 "FileVersion" "1.3.3.4"
VIAddVersionKey /LANG=1033 "LegalCopyright" "SpektraLab contributors; GPL-3.0-or-later"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\SpektraLab-Windows.exe"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "../../license/LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  SetShellVarContext current
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "SpektraLab requires 64-bit Windows."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "SpektraLab requires Windows 10 or later."
    Abort
  ${EndIf}
FunctionEnd

Function .onVerifyInstDir
  ${GetRoot} "$INSTDIR" $0
  ${If} $INSTDIR == $0
  ${OrIf} $INSTDIR == "$0\"
  ${OrIf} $INSTDIR == "$WINDIR"
  ${OrIf} $INSTDIR == "$SYSDIR"
  ${OrIf} $INSTDIR == "$PROGRAMFILES64"
    SetErrors
  ${EndIf}
FunctionEnd

Function CheckWebView
  ; Microsoft-documented Evergreen Runtime client registration, both views
  ; and installation scopes. The bootstrapper chooses the actual architecture.
  SetRegView 32
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $0 == ""
    SetRegView 64
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $0 == ""
    ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  SetRegView 64
FunctionEnd

Function CloseRunningEditor
  ; An older single-instance process can otherwise bring back its old page
  ; when the new shortcut launches. Interactive installation warns before
  ; closing it; the managed updater already flushes edits before /S.
  IfSilent close_editor
  MessageBox MB_ICONEXCLAMATION|MB_OKCANCEL "Setup will close running SpektraLab windows. Save your work before continuing." IDOK close_editor
  Abort "Close SpektraLab before installing."
close_editor:
  ; Target the GUI executable only. The managed updater helper has a distinct
  ; name, and an unrelated host or CLI process is never killed by name.
  ExecWait '$\"$SYSDIR\taskkill.exe$\" /F /IM SpektraLab-Windows.exe' $0
  Sleep 500
FunctionEnd

Section "SpektraLab" SEC_APP
  SetShellVarContext current
  ; The explicit skip is used only by installation-layout verification under
  ; Wine, which has no supported WebView2 runtime. It is never the default.
  ${GetParameters} $1
  ClearErrors
  ${GetOptions} $1 "/NO_WEBVIEW=" $2
  ${If} $2 != "1"
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "${STAGE}/MicrosoftEdgeWebview2Setup.exe"
    Call CheckWebView
    ${If} $0 == ""
    ${OrIf} $0 == "0.0.0.0"
      DetailPrint "Installing Microsoft WebView2 Runtime…"
      ExecWait '$\"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe$\" /silent /install' $1
      Call CheckWebView
      ${If} $0 == ""
      ${OrIf} $0 == "0.0.0.0"
        IfSilent +2
        MessageBox MB_ICONSTOP "Microsoft WebView2 Runtime was not installed. Check the network or restart Windows if requested, then run this installer again. No app files have been installed."
        SetErrorLevel 4
        Abort "WebView2 Runtime prerequisite was not met."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Call CloseRunningEditor
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r "${STAGE}/*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\SpektraLab LightTable"
  CreateShortcut "$SMPROGRAMS\SpektraLab LightTable\SpektraLab.lnk" "$INSTDIR\SpektraLab-Windows.exe"
  CreateShortcut "$SMPROGRAMS\SpektraLab LightTable\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\SpektraLab LightTable.lnk" "$INSTDIR\SpektraLab-Windows.exe"
  SetRegView 64
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpektraLabWindows133" "DisplayName" "SpektraLab Windows 1.3.3-lighttable.3 (build 13304)"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpektraLabWindows133" "DisplayVersion" "1.3.3-lighttable.3"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpektraLabWindows133" "Publisher" "SpektraLab contributors"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpektraLabWindows133" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpektraLabWindows133" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpektraLabWindows133" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpektraLabWindows133" "NoRepair" 1

SectionEnd

Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  Delete "$DESKTOP\SpektraLab LightTable.lnk"
  Delete "$SMPROGRAMS\SpektraLab LightTable\SpektraLab.lnk"
  Delete "$SMPROGRAMS\SpektraLab LightTable\Uninstall.lnk"
  RMDir "$SMPROGRAMS\SpektraLab LightTable"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SpektraLabWindows133"
  !include "${UNINSTALL_LIST}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  ; AppData caches, sidecars, recipes and original photographs are retained.
SectionEnd
