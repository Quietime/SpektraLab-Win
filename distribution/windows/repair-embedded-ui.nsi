Unicode true
Target amd64-unicode
!include "LogicLib.nsh"
!include "x64.nsh"
Name "SpektraLab 1.3.3 startup repair"
OutFile "${OUTFILE}"
InstallDir "E:\SpektraLab"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32
Page instfiles
ShowInstDetails show
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "64-bit Windows is required."
    Abort
  ${EndIf}
  IfFileExists "$INSTDIR\spektralab-host.exe" +3 0
    MessageBox MB_ICONSTOP "SpektraLab was not found in E:\SpektraLab. Install the full application first."
    Abort
  IfFileExists "$INSTDIR\WebView2Loader.dll" +3 0
    MessageBox MB_ICONSTOP "The existing installation is incomplete (WebView2Loader.dll is missing)."
    Abort
FunctionEnd
Section "Repair embedded frontend"
  SetOverwrite on
  SetOutPath "$INSTDIR"
  File "${STAGE}/SpektraLab-Windows.exe"
  File "${STAGE}/SpektraLab-CLI.exe"
  File "${STAGE}/BUILD-INFO.json"
  File "${STAGE}/README.zh-CN.md"
  File "${STAGE}/VALIDATION.zh-CN.md"
  SetOutPath "$INSTDIR\source"
  File "${STAGE}/source/SpektraLab-source.zip"
  File "${STAGE}/source/SOURCE-INDEX.json"
  File "${STAGE}/source/README-SOURCE.txt"
  SetOutPath "$INSTDIR"
  File "${STAGE}/SHA256SUMS.json"
  DetailPrint "Embedded UI installed. Photos and user settings are preserved."
  IfSilent done
    Exec '"$INSTDIR\SpektraLab-Windows.exe"'
  done:
SectionEnd
