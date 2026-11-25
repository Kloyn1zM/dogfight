export interface PerfReport {
  readonly durationSec: number
  readonly frames: number
  readonly frameMs: {
    readonly p50: number
    readonly p95: number
    readonly p99: number
    readonly max: number
  }
  readonly workMs: {
    readonly p50: number
    readonly p95: number
    readonly p99: number
    readonly max: number
  }
  readonly framesOver16_7ms: number
  readonly framesOver33_3ms: number
}

export interface FramePerfRecorder {
  readonly enabled: boolean
  readonly durationSec: number
  reset(): void
  recordFrame(now: number, frameTimeMs: number, workTimeMs: number): void
  getReport(): PerfReport | null
  getStatusText(now: number): string | null
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  return sorted[idx] ?? 0
}

function summarize(samples: readonly number[]): {
  p50: number
  p95: number
  p99: number
  max: number
} {
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    p50: Number(percentile(sorted, 0.5).toFixed(2)),
    p95: Number(percentile(sorted, 0.95).toFixed(2)),
    p99: Number(percentile(sorted, 0.99).toFixed(2)),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
  }
}

export function createFramePerfRecorder(
  durationSec: number,
  onComplete?: (report: PerfReport) => void,
): FramePerfRecorder {
  const enabled = Number.isFinite(durationSec) && durationSec > 0
  const frameSamples: number[] = []
  const workSamples: number[] = []
  let startedAt = 0
  let report: PerfReport | null = null

  function reset(): void {
    frameSamples.length = 0
    workSamples.length = 0
    startedAt = 0
    report = null
  }

  function recordFrame(
    now: number,
    frameTimeMs: number,
    workTimeMs: number,
  ): void {
    if (!enabled || report !== null) return
    if (frameTimeMs <= 0) return

    if (startedAt === 0) {
      startedAt = now
    }

    frameSamples.push(frameTimeMs)
    workSamples.push(workTimeMs)

    if (now - startedAt >= durationSec * 1000) {
      const frameStats = summarize(frameSamples)
      const workStats = summarize(workSamples)
      let over16 = 0
      let over33 = 0
      for (const f of frameSamples) {
        if (f > 16.7) over16 += 1
        if (f > 33.3) over33 += 1
      }
      report = {
        durationSec,
        frames: frameSamples.length,
        frameMs: frameStats,
        workMs: workStats,
        framesOver16_7ms: over16,
        framesOver33_3ms: over33,
      }
      onComplete?.(report)
    }
  }

  function getStatusText(now: number): string | null {
    if (!enabled) return null
    if (report) {
      return `PERF ${report.durationSec}s DONE | frame p50=${report.frameMs.p50} p95=${report.frameMs.p95} p99=${report.frameMs.p99}ms | work p99=${report.workMs.p99}ms | >16.7ms: ${report.framesOver16_7ms}`
    }
    if (startedAt === 0) {
      return `PERF ${durationSec}s READY (waiting for first frame)...`
    }
    const elapsed = Math.min(durationSec, (now - startedAt) / 1000)
    return `PERF REC ${elapsed.toFixed(1)}s / ${durationSec}s (${frameSamples.length} frames)`
  }

  return {
    enabled,
    durationSec,
    reset,
    recordFrame,
    getReport: () => report,
    getStatusText,
  }
}
