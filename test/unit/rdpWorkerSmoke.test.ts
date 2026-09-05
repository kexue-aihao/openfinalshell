import { describe, expect, it } from 'vitest'
import { RdpSmokeLedger, validateAcceptedRdpSmokeExit } from '../../scripts/rdpSmokeLedger.mjs'

describe('real RDP worker smoke request ledger', () => {
  it('requires an exact request id and response kind for every operation', () => {
    const ledger = new RdpSmokeLedger()
    ledger.register(10, 'key', 'ack')
    expect(() => ledger.consume({ type: 0x20, requestId: 11, json: { op: 'ack' } })).toThrow('unexpected response request id')
    expect(() => ledger.consume({ type: 0x22, requestId: 10, json: { op: 'clipboardData' } })).toThrow('expected ack')
    expect(ledger.consume({ type: 0x20, requestId: 10, json: { op: 'ack' } })).toBe('key')
    expect(() => ledger.assertComplete()).not.toThrow()
  })

  it('never treats ERROR, failed state, or an errorCode as a successful response', () => {
    const ledger = new RdpSmokeLedger()
    ledger.register(20, 'resize', 'ack')
    expect(() => ledger.consume({ type: 0x7f, requestId: 20, json: { op: 'error', code: 'UNSUPPORTED' } })).toThrow('worker ERROR')
    expect(() => ledger.consume({ type: 0x20, requestId: 0, json: { op: 'state', state: 'failed', errorCode: 'NETWORK_ERROR' } })).toThrow('worker failed')
    expect(() => ledger.consume({ type: 0x20, requestId: 0, json: { op: 'state', state: 'ready', errorCode: 'NETWORK_ERROR' } })).toThrow('worker failed')
  })

  it('reports each missing ACK or expected response at process exit', () => {
    const ledger = new RdpSmokeLedger()
    ledger.register(30, 'pointer', 'ack')
    ledger.register(31, 'clipboardGet', 'clipboardData')
    expect(() => ledger.assertComplete()).toThrow('pointer#30:ack, clipboardGet#31:clipboardData')
  })

  it('rejects non-zero exits, truncated frames, and exit before closed', () => {
    const completeFlags = {
      hello: true,
      credentialSent: true,
      ready: true,
      frameSeen: true,
      controlsSent: true,
      closeSent: true,
      closed: true
    }
    expect(() => validateAcceptedRdpSmokeExit({
      code: 2, bufferedBytes: 0, flags: completeFlags, ledger: new RdpSmokeLedger()
    })).toThrow('non-zero code 2')
    expect(() => validateAcceptedRdpSmokeExit({
      code: 0, bufferedBytes: 4, flags: completeFlags, ledger: new RdpSmokeLedger()
    })).toThrow('truncated output frame')
    expect(() => validateAcceptedRdpSmokeExit({
      code: 0, bufferedBytes: 0, flags: { ...completeFlags, closed: false }, ledger: new RdpSmokeLedger()
    })).toThrow('incomplete: closed')
  })
})
