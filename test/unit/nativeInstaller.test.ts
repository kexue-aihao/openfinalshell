import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const installer = readFileSync('windows/installer/OpenFinalShell.NativePreview.nsi', 'utf8')

describe('WinUI 3 native installer', () => {
  it('uses the assisted MUI2 wizard style used by the Electron installer', () => {
    expect(installer).toContain('!include "MUI2.nsh"')
    expect(installer).toContain('!insertmacro MUI_PAGE_WELCOME')
    expect(installer).toContain('!insertmacro MUI_PAGE_DIRECTORY')
    expect(installer).toContain('!insertmacro MUI_PAGE_FINISH')
    expect(installer).toContain('!insertmacro MUI_UNPAGE_WELCOME')
    expect(installer).toContain('!insertmacro MUI_UNPAGE_FINISH')
  })

  it('registers and completely removes the per-user installation', () => {
    expect(installer).toContain('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenFinalShell.NativePreview')
    expect(installer).toContain("nsExec::ExecToLog 'taskkill.exe /F /T /IM OpenFinalShell.App.exe'")
    expect(installer).toContain('Delete "$INSTDIR\\Uninstall.exe"')
    expect(installer).toContain('RMDir /r "$INSTDIR"')
    expect(installer).toContain('DeleteRegKey HKCU "${UNINSTALL_REG_KEY}"')
  })
})
