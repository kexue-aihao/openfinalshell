Unicode True
!include "FileFunc.nsh"

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
OutFile "${OUT_DIR}\OpenFinalShell-NativePreview-${VERSION}-${ARCH}-Setup.exe"
InstallDir "$LOCALAPPDATA\OpenFinalShell Native Preview"
RequestExecutionLevel user
InstallDirRegKey HKCU "Software\OpenFinalShell.NativePreview" "InstallDir"
SetCompressor /SOLID lzma

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Function .onInit
  ${GetParameters} $R0
  ${GetOptions} $R0 "/WAITPID=" $OFS_WAIT_PID
FunctionEnd

Function WaitForPreviousApplication
  StrCmp $OFS_WAIT_PID "" done
  IntOp $0 $OFS_WAIT_PID + 0
wait_loop:
  System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i r2) p .r0'
  StrCmp $0 "0" done
  System::Call 'kernel32::WaitForSingleObject(p r0, i 250) i .r1'
  System::Call 'kernel32::CloseHandle(p r0)'
  StrCmp $1 "0" done
  Sleep 250
  Goto wait_loop
done:
FunctionEnd

Section "Application"
  Call WaitForPreviousApplication
  SetOutPath "$INSTDIR"
  File /r "${INPUT_DIR}\*.*"
  WriteRegStr HKCU "Software\OpenFinalShell.NativePreview" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\OpenFinalShell.NativePreview" "Version" "${VERSION}"
  CreateShortCut "$DESKTOP\OpenFinalShell Native Preview.lnk" "$INSTDIR\OpenFinalShell.App.exe"
  CreateDirectory "$SMPROGRAMS\OpenFinalShell Native Preview"
  CreateShortCut "$SMPROGRAMS\OpenFinalShell Native Preview\OpenFinalShell Native Preview.lnk" "$INSTDIR\OpenFinalShell.App.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  Exec '"$INSTDIR\OpenFinalShell.App.exe"'
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\OpenFinalShell Native Preview.lnk"
  Delete "$SMPROGRAMS\OpenFinalShell Native Preview\OpenFinalShell Native Preview.lnk"
  RMDir "$SMPROGRAMS\OpenFinalShell Native Preview"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\OpenFinalShell.NativePreview"
  ; NativeStore data is deliberately outside the install directory and is retained
  ; for migration/recovery. A future migration wizard must offer explicit deletion.
SectionEnd
