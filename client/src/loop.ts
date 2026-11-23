export interface LoopStats {
  stepsPerSecond: number
  framesPerSecond: number
  frameTimeMs: number
  workTimeMs: number
  totalSteps: number
}

export interface CreateLoopOptions {
  step?: number
  maxDelta?: number
  simulate: (dt: number) => void
  render: (alpha: number, stats: LoopStats) => void
}

export interface GameLoop {
  start(): void
  stop(): void
  isRunning(): boolean
  getStats(): LoopStats
}

export function createLoop({
  step = 1 / 60,
  maxDelta = 0.25,
  simulate,
  render,
}: CreateLoopOptions): GameLoop {
  let rafId = 0
  let running = false
  let last = 0
  let accumulator = 0

  let stepsThisSecond = 0
  let framesThisSecond = 0
  let statsAt = 0

  const stats: LoopStats = {
    stepsPerSecond: 0,
    framesPerSecond: 0,
    frameTimeMs: 0,
    workTimeMs: 0,
    totalSteps: 0,
  }

  function frame(now: number): void {
    if (!running) return

    const workStart = performance.now()
    const dt = last === 0 ? 0 : (now - last) / 1000
    last = now

    if (statsAt === 0) statsAt = now

    stats.frameTimeMs = dt * 1000
    accumulator += Math.min(Math.max(dt, 0), maxDelta)

    while (accumulator >= step) {
      simulate(step)
      accumulator -= step
      stepsThisSecond += 1
      stats.totalSteps += 1
    }

    const alpha = accumulator / step
    render(alpha, stats)
    framesThisSecond += 1

    if (now - statsAt >= 1000) {
      stats.stepsPerSecond = stepsThisSecond
      stats.framesPerSecond = framesThisSecond
      stepsThisSecond = 0
      framesThisSecond = 0
      statsAt = now
    }

    stats.workTimeMs = performance.now() - workStart

    if (running) {
      rafId = requestAnimationFrame(frame)
    }
  }

  return {
    start() {
      if (running) return
      running = true
      last = 0
      accumulator = 0
      stepsThisSecond = 0
      framesThisSecond = 0
      statsAt = 0
      rafId = requestAnimationFrame(frame)
    },
    stop() {
      if (!running) return
      running = false
      cancelAnimationFrame(rafId)
      rafId = 0
    },
    isRunning: () => running,
    getStats: () => stats,
  }
}
