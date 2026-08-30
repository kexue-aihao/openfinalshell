import { describe, expect, it } from 'vitest'
import { SHARED_SCHEMA_FILES } from '../../src/shared/generated/sharedSchema'

describe('shared protocol schema registry', () => {
  it('contains every cross-platform contract', () => {
    expect(SHARED_SCHEMA_FILES).toEqual([
      'export-envelope',
      'lansync',
      'monitor-snapshot',
      'port-traffic'
    ])
  })
})
