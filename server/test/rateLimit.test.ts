import { afterEach, describe, expect, it, vi } from 'vitest'
import { TokenBucket } from '../src/rateLimit.ts'

describe('TokenBucket rate limiter', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows immediate burst up to capacity and rejects excess', () => {
    const now = 0
    const bucket = new TokenBucket(10, 5, () => now)

    for (let i = 0; i < 5; i += 1) {
      expect(bucket.take(1)).toBe(true)
    }
    expect(bucket.take(1)).toBe(false)
  })

  it('refills tokens proportionally over elapsed time', () => {
    let now = 0
    const bucket = new TokenBucket(20, 4, () => now)

    expect(bucket.take(4)).toBe(true)
    expect(bucket.take(1)).toBe(false)

    now += 100 // 0.1s * 20/s = 2 tokens
    expect(bucket.take(1)).toBe(true)
    expect(bucket.take(1)).toBe(true)
    expect(bucket.take(1)).toBe(false)
  })

  it('caps refilled tokens at burst capacity', () => {
    let now = 0
    const bucket = new TokenBucket(100, 3, () => now)
    expect(bucket.take(3)).toBe(true)

    now += 10_000
    expect(bucket.take(3)).toBe(true)
    expect(bucket.take(1)).toBe(false)
  })

  it('supports variable cost per take call', () => {
    const now = 0
    const bucket = new TokenBucket(10, 10, () => now)

    expect(bucket.take(6)).toBe(true)
    expect(bucket.take(5)).toBe(false)
    expect(bucket.take(4)).toBe(true)
  })

  it('works with Vitest fake timers using default performance.now()', () => {
    vi.useFakeTimers()
    const bucket = new TokenBucket(10, 2)

    expect(bucket.take(2)).toBe(true)
    expect(bucket.take(1)).toBe(false)

    vi.advanceTimersByTime(250) // +2.5 tokens -> capped at 2
    expect(bucket.take(2)).toBe(true)
    expect(bucket.take(1)).toBe(false)
  })

  it('guards against backward clock jumps', () => {
    let now = 500
    const bucket = new TokenBucket(10, 2, () => now)
    expect(bucket.take(2)).toBe(true)

    now = 100
    expect(bucket.take(1)).toBe(false)
  })
})
