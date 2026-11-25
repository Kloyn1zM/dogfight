import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLoop } from '../src/loop.ts'

describe('createLoop fixed-timestep game loop (fake timers)', () => {
  let nextRafId = 1
  const rafQueue = new Map<number, () => void>()

  beforeEach(() => {
    vi.useFakeTimers()
    nextRafId = 1
    rafQueue.clear()

    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = nextRafId++
      const timer = setTimeout(() => {
        rafQueue.delete(id)
        cb(performance.now())
      }, 16)
      rafQueue.set(id, () => clearTimeout(timer))
      return id
    })

    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      const cancel = rafQueue.get(id)
      if (cancel) {
        cancel()
        rafQueue.delete(id)
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function installCustomFramePacing(intervalMs: number): void {
    rafQueue.clear()
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = nextRafId++
      const timer = setTimeout(() => {
        rafQueue.delete(id)
        cb(performance.now())
      }, intervalMs)
      rafQueue.set(id, () => clearTimeout(timer))
      return id
    })
  }

  it('runs exactly 60 simulation steps per second at 60 Hz display refresh', () => {
    installCustomFramePacing(1000 / 60)
    const simulate = vi.fn()
    const render = vi.fn()

    const loop = createLoop({ step: 1 / 60, simulate, render })
    loop.start()
    vi.advanceTimersByTime(1000 + 20)
    loop.stop()

    expect(simulate.mock.calls.length).toBeGreaterThanOrEqual(59)
    expect(simulate.mock.calls.length).toBeLessThanOrEqual(61)
    expect(render.mock.calls.length).toBeGreaterThanOrEqual(59)
  })

  it('runs the same simulation step rate on 120 Hz and 30 Hz monitors', () => {
    installCustomFramePacing(1000 / 120)
    const sim120 = vi.fn()
    const loop120 = createLoop({ step: 1 / 60, simulate: sim120, render: vi.fn() })
    loop120.start()
    vi.advanceTimersByTime(1000 + 10)
    loop120.stop()

    installCustomFramePacing(1000 / 30)
    const sim30 = vi.fn()
    const loop30 = createLoop({ step: 1 / 60, simulate: sim30, render: vi.fn() })
    loop30.start()
    vi.advanceTimersByTime(1000 + 34)
    loop30.stop()

    expect(Math.abs(sim120.mock.calls.length - sim30.mock.calls.length)).toBeLessThanOrEqual(2)
  })

  it('clamps huge frame deltas with maxDelta to prevent spiral of death', () => {
    const holder: { cb: ((now: number) => void) | null } = { cb: null }
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      holder.cb = cb
      return nextRafId++
    })

    const simulate = vi.fn()
    const loop = createLoop({
      step: 1 / 60,
      maxDelta: 0.25,
      simulate,
      render: vi.fn(),
    })

    loop.start()
    holder.cb?.(1000) // first frame initializes last
    expect(simulate).toHaveBeenCalledTimes(0)

    holder.cb?.(11_000) // 10-second freeze clamped to 0.25s = 15 steps
    expect(simulate).toHaveBeenCalledTimes(15)
    loop.stop()
  })

  it('passes interpolation alpha in [0, 1) to render', () => {
    const holder: { cb: ((now: number) => void) | null } = { cb: null }
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      holder.cb = cb
      return nextRafId++
    })

    const alphas: number[] = []
    const loop = createLoop({
      step: 1 / 30,
      simulate: vi.fn(),
      render(alpha) {
        alphas.push(alpha)
      },
    })

    loop.start()
    holder.cb?.(1000)
    holder.cb?.(1050) // 0.05s = 1 step (0.03333s) + 0.01667s remainder -> alpha ~0.5
    loop.stop()

    expect(alphas).toHaveLength(2)
    expect(alphas[0]).toBe(0)
    expect(alphas[1]).toBeCloseTo(0.5, 2)
  })

  it('updates stepsPerSecond and framesPerSecond stats after 1 second', () => {
    installCustomFramePacing(1000 / 60)
    const loop = createLoop({
      step: 1 / 30,
      simulate: vi.fn(),
      render: vi.fn(),
    })

    loop.start()
    vi.advanceTimersByTime(1050)
    const stats = loop.getStats()
    loop.stop()

    expect(stats.stepsPerSecond).toBeGreaterThanOrEqual(29)
    expect(stats.stepsPerSecond).toBeLessThanOrEqual(31)
    expect(stats.framesPerSecond).toBeGreaterThanOrEqual(58)
    expect(stats.totalSteps).toBeGreaterThanOrEqual(29)
  })

  it('stops cleanly and ignores duplicate start/stop calls', () => {
    installCustomFramePacing(16)
    const render = vi.fn()
    const loop = createLoop({ step: 1 / 60, simulate: vi.fn(), render })

    loop.start()
    loop.start()
    expect(loop.isRunning()).toBe(true)

    vi.advanceTimersByTime(64)
    const countBeforeStop = render.mock.calls.length
    loop.stop()
    loop.stop()
    expect(loop.isRunning()).toBe(false)

    vi.advanceTimersByTime(200)
    expect(render.mock.calls.length).toBe(countBeforeStop)
  })
})
