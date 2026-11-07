Unicode True
!include "MUI2.nsh"
!include "FileFunc.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON "${INPUT_DIR}\Assets\OpenFinalShell.ico"
!define MUI_UNICON "${INPUT_DIR}\Assets\OpenFinalShell.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\OpenFinalShell.App.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch OpenFinalShell"
!define MUI_FINISHPAGE_RUN_CHECKED

Var OFS_WAIT_PID
!ifndef INPUT_DIR
  !error "INPUT_DIR is required"
!endif
!ifndef ARCH
  !define ARCH x64
!endif
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef OUT_DIR
  !define OUT_DIR "."
!endif

Name "OpenFinalShell Native Preview"
Caption "OpenFinalShell Native Preview ${ARCH}"
BrandingText "OpenFinalShell"
OutFile "${OUT_DIR}\OpenFinalShell-NativePreview-${VERSION}-${ARCH}-Setup.exe"
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "OpenFinalShell Native Preview"
VIAddVersionKey /LANG=2052 "CompanyName" "openfinalshell contributors"
VIAddVersionKey /LANG=2052 "FileDescription" "OpenFinalShell Native Preview installer"
VIAddVersionKey /LANG=2052 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Copyright © 2026 openfinalshell contributors"
VIAddVersionKey /LANG=1033 "ProductName" "OpenFinalShell Native Preview"
VIAddVersionKey /LANG=1033 "CompanyName" "openfinalshell contributors"
VIAddVersionKey /LANG=1033 "FileDescription" "OpenFinalShell Native Preview installer"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright © 2026 openfinalshell contributors"
; Keep the native preview install alongside other machine-wide Windows apps.
; PROGRAMFILES64 resolves to C:\Program Files on 64-bit Windows for every
; native preview architecture (x64, x86 and ARM64).
InstallDir "$PROGRAMFILES64\OpenFinalShell Native Preview"
RequestExecutionLevel admin
InstallDirRegKey HKCU "Software\OpenFinalShell.NativePreview" "InstallDir"
SetCompressor /SOLID lzma

!define UNINSTALL_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenFinalShell.NativePreview"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${GetParameters} $R0
  ${GetOptions} $R0 "/WAITPID=" $OFS_WAIT_PID
FunctionEnd

Function WaitForPreviousApplication
  StrCmp $OFS_WAIT_PID "" done
  IntOp $2 $OFS_WAIT_PID + 0
  StrCpy $3 0
wait_loop:
  System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i r2) p .r0'
  StrCmp $0 "0" done
  System::Call 'kernel32::WaitForSingleObject(p r0, i 250) i .r1'
  System::Call 'kernel32::CloseHandle(p r0)'
  StrCmp $1 "0" done
  IntOp $3 $3 + 1
  IntCmp $3 120 timed_out wait_again timed_out
wait_again:
  Sleep 250
  Goto wait_loop
timed_out:
  MessageBox MB_ICONSTOP "OpenFinalShell is still running. Installation was canceled; please close the application and retry." /SD IDOK
  SetErrorLevel 2
  Quit
done:
FunctionEnd

Section "Application"
  Call WaitForPreviousApplication
  SetOutPath "$INSTDIR"
  File /r "${INPUT_DIR}\*.*"
  WriteRegStr HKCU "Software\OpenFinalShell.NativePreview" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\OpenFinalShell.NativePreview" "Version" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "DisplayName" "OpenFinalShell Native Preview"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "Publisher" "openfinalshell contributors"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "DisplayIcon" "$INSTDIR\OpenFinalShell.App.exe"
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_REG_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_REG_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_REG_KEY}" "NoRepair" 1
  CreateShortCut "$DESKTOP\OpenFinalShell Native Preview.lnk" "$INSTDIR\OpenFinalShell.App.exe"
  CreateDirectory "$SMPROGRAMS\OpenFinalShell Native Preview"
  CreateShortCut "$SMPROGRAMS\OpenFinalShell Native Preview\OpenFinalShell Native Preview.lnk" "$INSTDIR\OpenFinalShell.App.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  nsExec::ExecToLog 'taskkill.exe /F /T /IM OpenFinalShell.App.exe'
  Sleep 500
  Delete "$DESKTOP\OpenFinalShell Native Preview.lnk"
  Delete "$SMPROGRAMS\OpenFinalShell Native Preview\OpenFinalShell Native Preview.lnk"
  RMDir "$SMPROGRAMS\OpenFinalShell Native Preview"
  SetOutPath "$TEMP"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\OpenFinalShell.NativePreview"
  DeleteRegKey HKCU "${UNINSTALL_REG_KEY}"
  ; NativeStore data is deliberately outside the install directory and is retained
  ; for migration/recovery. A future migration wizard must offer explicit deletion.
SectionEnd
