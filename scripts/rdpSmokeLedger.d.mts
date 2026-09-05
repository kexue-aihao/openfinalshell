export interface RdpSmokeEntry {
  type: number
  requestId: number
  json?: Record<string, unknown>
}

export class RdpSmokeLedger {
  register(requestId: number, name: string, expected: string): void
  consume(entry: RdpSmokeEntry): string | null
  readonly pendingCount: number
  assertComplete(): void
}

export function validateAcceptedRdpSmokeExit(input: {
  code: number | null
  bufferedBytes: number
  flags: Record<string, boolean>
  ledger: RdpSmokeLedger
}): void
