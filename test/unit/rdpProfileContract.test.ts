import { describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '../../src/shared/types'
import { profileDraftSchema } from '../../src/main/ipc/conn.ipc'

const baseDraft = {
  name: 'server',
  groupId: null,
  host: 'example.test',
  port: 22,
  username: 'root',
  auth: { method: 'password' as const },
  terminal: { charset: 'utf-8', termType: 'xterm-256color' },
  options: {
    keepaliveInterval: 15_000,
    readyTimeout: 20_000,
    legacyAlgorithms: false,
    autoReconnect: true,
    monitorEnabled: true,
    compress: false
  }
}

describe('RDP profile contract compatibility', () => {
  it('keeps legacy SSH and RDP profile shapes readable', () => {
    const legacySsh: ConnectionProfile = {
      ...baseDraft,
      id: 'legacy-ssh',
      createdAt: 1,
      updatedAt: 1
    }
    const legacyRdp: ConnectionProfile = {
      ...legacySsh,
      id: 'legacy-rdp',
      protocol: 'rdp',
      port: 3389,
      username: ''
    }

    expect(legacySsh.protocol).toBeUndefined()
    expect(legacySsh.rdp).toBeUndefined()
    expect(legacyRdp.protocol).toBe('rdp')
    expect(legacyRdp.rdp).toBeUndefined()
  })

  it('accepts optional RDP settings while retaining the legacy SSH username rule', () => {
    expect(profileDraftSchema.safeParse({ ...baseDraft, protocol: undefined }).success).toBe(true)
    expect(profileDraftSchema.safeParse({ ...baseDraft, username: '' }).success).toBe(false)
    expect(profileDraftSchema.safeParse({
      ...baseDraft,
      protocol: 'rdp',
      port: 3389,
      username: ''
    }).success).toBe(true)
    expect(profileDraftSchema.safeParse({
      ...baseDraft,
      protocol: 'rdp',
      port: 3389,
      rdp: { domain: 'CORP' }
    }).success).toBe(true)
    expect(profileDraftSchema.safeParse({
      ...baseDraft,
      protocol: 'rdp',
      port: 3389,
      rdp: { domain: 'CORP', clipboard: false, certificatePolicy: 'strict' }
    }).success).toBe(true)
  })
})
