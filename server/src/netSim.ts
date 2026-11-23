export interface NetSimConfig {
  readonly rttMs: number
  readonly jitterMs: number
  readonly dropRate: number
  readonly droppedPackets: number
}

export interface NetSimInput {
  rttMs?: number
  jitterMs?: number
  dropRate?: number
}

export class NetSimulator {
  rttMs: number
  jitterMs: number
  dropRate: number
  droppedPackets = 0

  constructor({ rttMs = 0, jitterMs = 0, dropRate = 0 }: NetSimInput = {}) {
    this.rttMs = rttMs
    this.jitterMs = jitterMs
    this.dropRate = dropRate
  }

  configure({ rttMs = 0, jitterMs = 0, dropRate = 0 }: NetSimInput = {}): void {
    this.rttMs = Math.max(0, Math.min(600, Number(rttMs) || 0))
    this.jitterMs = Math.max(0, Math.min(200, Number(jitterMs) || 0))
    this.dropRate = Math.max(0, Math.min(0.3, Number(dropRate) || 0))
  }

  getConfig(): NetSimConfig {
    return {
      rttMs: this.rttMs,
      jitterMs: this.jitterMs,
      dropRate: this.dropRate,
      droppedPackets: this.droppedPackets,
    }
  }

  schedule(fn: () => void, { allowDrop = true } = {}): boolean {
    if (allowDrop && this.dropRate > 0 && Math.random() < this.dropRate) {
      this.droppedPackets += 1
      return false
    }

    const oneWayBase = this.rttMs / 2
    const oneWayJitter = this.jitterMs / 2
    if (oneWayBase <= 0 && oneWayJitter <= 0) {
      fn()
      return true
    }

    const jitterOffset = (Math.random() * 2 - 1) * oneWayJitter
    const delayMs = Math.max(0, Math.round(oneWayBase + jitterOffset))
    if (delayMs === 0) {
      fn()
    } else {
      setTimeout(fn, delayMs)
    }
    return true
  }
}
