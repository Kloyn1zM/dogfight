/**
 * Fixed-timestep game loop поверх браузерного requestAnimationFrame.
 *
 * - Симуляція завжди крокує фіксованим dt (за замовчуванням 1/60 с),
 *   щоб фізика була детермінованою незалежно від частоти монітора (60/120/144 Hz).
 * - Накопичений час обмежується maxDelta (0.25 с), щоб після повернення
 *   з фонової вкладки або фрізу не виникала "спіраль смерті".
 * - Рендер отримує alpha в діапазоні [0, 1) для інтерполяції між станами.
 */
export function createLoop({
  step = 1 / 60,
  maxDelta = 0.25,
  simulate,
  render,
} = {}) {
  let rafId = 0
  let running = false
  let last = 0
  let accumulator = 0

  let stepsThisSecond = 0
  let framesThisSecond = 0
  let statsAt = 0

  const stats = {
    stepsPerSecond: 0,
    framesPerSecond: 0,
    frameTimeMs: 0,
    workTimeMs: 0,
    totalSteps: 0,
  }

  function frame(now) {
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
