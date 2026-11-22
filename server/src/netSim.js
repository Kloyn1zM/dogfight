/**
 * Інжектор штучної затримки, джитеру та втрати пакетів.
 * Працює в обидва боки (вхідні інпути + вихідні снапшоти/pong),
 * тому налаштування rttMs = 100 дає ~50 ms у кожен бік (сумарний RTT ~100 ms).
 */
export class NetSimulator {
  constructor({ rttMs = 0, jitterMs = 0, dropRate = 0 } = {}) {
    this.rttMs = rttMs
    this.jitterMs = jitterMs
    this.dropRate = dropRate
    this.droppedPackets = 0
  }

  configure({ rttMs = 0, jitterMs = 0, dropRate = 0 } = {}) {
    this.rttMs = Math.max(0, Math.min(600, Number(rttMs) || 0))
    this.jitterMs = Math.max(0, Math.min(200, Number(jitterMs) || 0))
    this.dropRate = Math.max(0, Math.min(0.3, Number(dropRate) || 0))
  }

  getConfig() {
    return {
      rttMs: this.rttMs,
      jitterMs: this.jitterMs,
      dropRate: this.dropRate,
      droppedPackets: this.droppedPackets,
    }
  }

  /**
   * Пропускає доставку через затримку/втрату.
   * Якщо всі параметри 0 — викликає fn() синхронно без таймера.
   */
  schedule(fn, { allowDrop = true } = {}) {
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
