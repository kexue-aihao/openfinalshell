import { describe, expect, it } from 'vitest'
import { createInstanceContext } from '../../src/main/instance'

describe('InstanceContext', () => {
  it('creates unique non-reusable ids', () => {
    const a = createInstanceContext(false)
    const b = createInstanceContext(true)
    expect(a.instanceId).not.toBe(b.instanceId)
    expect(a.isExplicitNewInstance).toBe(false)
    expect(b.isExplicitNewInstance).toBe(true)
    expect(a.closing).toBe(false)
  })
})
