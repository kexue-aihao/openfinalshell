import { describe, expect, it } from 'vitest'
import { settingsPatchSchema } from '../../src/main/ipc/settings.ipc'

describe('settingsPatchSchema', () => {
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
