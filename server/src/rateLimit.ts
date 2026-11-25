export class TokenBucket {
  readonly rate: number
  readonly capacity: number
  readonly #now: () => number
  tokens: number
  lastRefill: number

  constructor(
    ratePerSec: number,
    burst = ratePerSec,
    now: () => number = () => performance.now(),
  ) {
    this.rate = ratePerSec
    this.capacity = burst
    this.#now = now
    this.tokens = burst
    this.lastRefill = this.#now()
  }

  take(cost = 1): boolean {
    const current = this.#now()
    const elapsedSec = Math.max(0, (current - this.lastRefill) / 1000)
    this.lastRefill = current
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.rate)
    if (this.tokens < cost) return false
    this.tokens -= cost
    return true
  }
}
