import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { expandPath } from '../../src/main/utils/expandPath'

describe('expandPath', () => {
  it('展开 ~/ 前缀到用户目录', () => {
    expect(expandPath('~/.ssh/id_ed25519')).toBe(`${homedir()}/.ssh/id_ed25519`)
  })

  it('展开 ~\\ 前缀（Windows 手填风格）', () => {
    expect(expandPath('~\\.ssh\\id_rsa')).toBe(`${homedir()}\\.ssh\\id_rsa`)
  })

  it('单独一个 ~ 也展开', () => {
    expect(expandPath('~')).toBe(homedir())
  })

  it('~user 形式不展开（OpenSSH 客户端也不做）', () => {
    expect(expandPath('~root/.ssh/id_rsa')).toBe('~root/.ssh/id_rsa')
  })

  it('路径中间的 ~ 不动', () => {
    expect(expandPath('C:\\keys\\a~b\\id_rsa')).toBe('C:\\keys\\a~b\\id_rsa')
  })

  it('绝对路径原样返回', () => {
    expect(expandPath('C:\\Users\\me\\.ssh\\id_ed25519')).toBe('C:\\Users\\me\\.ssh\\id_ed25519')
    expect(expandPath('/home/me/.ssh/id_ed25519')).toBe('/home/me/.ssh/id_ed25519')
  })

  it('首尾空白剔除（粘贴路径常带）', () => {
    expect(expandPath('  ~/.ssh/key  ')).toBe(`${homedir()}/.ssh/key`)
  })

  it.runIf(process.platform === 'win32')('Windows 上展开 %VAR%', () => {
    expect(expandPath('%FOO%\\.ssh\\key', { FOO: 'D:\\home' })).toBe('D:\\home\\.ssh\\key')
  })

  it.runIf(process.platform === 'win32')('查不到的 %VAR% 原样保留而不是替换成空串', () => {
    // 静默替换成空串会把路径悄悄改坏；原样保留让报错信息里能看到没展开的变量名
    expect(expandPath('%NOPE_NOT_SET%\\key', {})).toBe('%NOPE_NOT_SET%\\key')
  })

  it.runIf(process.platform === 'win32')('~ 与 %VAR% 可同时出现', () => {
    expect(expandPath('~/%SUB%/key', { SUB: 'ssh' })).toBe(`${homedir()}/ssh/key`)
  })
})
