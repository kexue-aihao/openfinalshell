import { describe, expect, it } from 'vitest'
import { settingsPatchSchema } from '../../src/main/ipc/settings.ipc'

describe('settingsPatchSchema', () => {
  it('accepts only boolean multi-instance preferences', () => {
    expect(settingsPatchSchema.safeParse({ multiInstanceEnabled: true }).success).toBe(true)
    expect(settingsPatchSchema.safeParse({ multiInstanceEnabled: false }).success).toBe(true)
    for (const value of ['true', 1, null, {}]) {
      expect(settingsPatchSchema.safeParse({ multiInstanceEnabled: value }).success).toBe(false)
    }
  })
  it('接受 reduceTransparency 的布尔更新，并继续兼容其他设置 patch', () => {
    const parsed = settingsPatchSchema.safeParse({
      reduceTransparency: true,
      themeMode: 'dark'
    })
    expect(parsed.success).toBe(true)
  })

  it('拒绝 reduceTransparency 的非布尔外来值', () => {
    expect(settingsPatchSchema.safeParse({ reduceTransparency: 'true' }).success).toBe(false)
  })
})
