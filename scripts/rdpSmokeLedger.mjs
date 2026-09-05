export class RdpSmokeLedger {
  #pending = new Map()

  register(requestId, name, expected) {
    if (!Number.isInteger(requestId) || requestId <= 0 || requestId > 0xffffffff) {
      throw new Error(`invalid request id for ${name}: ${requestId}`)
    }
    if (this.#pending.has(requestId)) throw new Error(`duplicate request id ${requestId}`)
    this.#pending.set(requestId, { name, expected })
  }

  consume(entry) {
    if (entry.type === 0x7f) {
      throw new Error(`worker ERROR ${entry.json?.code ?? 'UNKNOWN'} for request ${entry.requestId}`)
    }
    if (entry.type === 0x20 && entry.json?.op === 'state' &&
        (entry.json.state === 'failed' || entry.json.errorCode)) {
      throw new Error(`worker failed with ${entry.json.errorCode ?? 'UNKNOWN'}`)
    }
    if (entry.requestId === 0) return null
    const pending = this.#pending.get(entry.requestId)
    if (!pending) throw new Error(`unexpected response request id ${entry.requestId}`)
    const actual = entry.type === 0x20 && entry.json?.op === 'ack'
      ? 'ack'
      : entry.type === 0x20 && entry.json?.op === 'state'
        ? `state:${entry.json.state}`
        : entry.type === 0x22 && entry.json?.op === 'clipboardData'
          ? 'clipboardData'
          : `type:${entry.type}`
    if (actual !== pending.expected) {
      throw new Error(`${pending.name} request ${entry.requestId} expected ${pending.expected}, received ${actual}`)
    }
    this.#pending.delete(entry.requestId)
    return pending.name
  }

  get pendingCount() {
    return this.#pending.size
  }

  assertComplete() {
    if (this.#pending.size === 0) return
    const missing = [...this.#pending.entries()]
      .map(([requestId, value]) => `${value.name}#${requestId}:${value.expected}`)
      .join(', ')
    throw new Error(`missing worker responses: ${missing}`)
  }
}

export function validateAcceptedRdpSmokeExit({ code, bufferedBytes, flags, ledger }) {
  if (code !== 0) throw new Error(`accepted RDP scenario exited with non-zero code ${code}`)
  if (bufferedBytes !== 0) throw new Error('accepted RDP scenario exited with a truncated output frame')
  const missing = Object.entries(flags).filter(([, value]) => !value).map(([name]) => name)
  if (missing.length > 0) throw new Error(`accepted RDP scenario incomplete: ${missing.join(', ')}`)
  ledger.assertComplete()
}
