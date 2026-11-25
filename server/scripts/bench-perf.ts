import { PerformanceObserver } from 'node:perf_hooks'
import {
  MatchWorld,
  TICK_DT,
  asEntityId,
  asSeq,
  asTick,
  binaryCodec,
  type CollisionMode,
  type EntityId,
  type InputCommand,
} from '@dogfight/shared'
import { NetWorld } from '../../client/src/net/netWorld.ts'

type StepInput = Pick<InputCommand, 'turn' | 'thrust' | 'fire' | 'fireHoming'>

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  return sorted[idx] ?? 0
}

function summarize(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  return {
    avgMs: Number((sum / Math.max(1, sorted.length)).toFixed(4)),
    p50Ms: Number(percentile(sorted, 0.5).toFixed(4)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(4)),
    p99Ms: Number(percentile(sorted, 0.99).toFixed(4)),
    maxMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(4)),
  }
}

interface GcSummary {
  count: number
  totalMs: number
  maxMs: number
}

function createGcTracker(): { stop(): Promise<GcSummary> } {
  let count = 0
  let totalMs = 0
  let maxMs = 0

  const obs = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      count += 1
      totalMs += entry.duration
      if (entry.duration > maxMs) maxMs = entry.duration
    }
  })
  obs.observe({ entryTypes: ['gc'] })

  return {
    async stop() {
      await new Promise((r) => setImmediate(r))
      obs.disconnect()
      return {
        count,
        totalMs: Number(totalMs.toFixed(2)),
        maxMs: Number(maxMs.toFixed(2)),
      }
    },
  }
}

async function benchServerMatchWorld(
  shipCount: number,
  collisionMode: CollisionMode,
  ticks = 900,
) {
  const world = new MatchWorld({
    seed: 2026,
    targetAsteroids: Math.min(60, Math.max(8, Math.floor(shipCount * 0.6))),
    collisionMode,
  })
  const inputs = new Map<EntityId, StepInput>()

  for (let i = 1; i <= shipCount; i += 1) {
    const id = asEntityId(i)
    world.addShip(id)
    inputs.set(id, {
      turn: i % 3 === 0 ? 1 : i % 3 === 1 ? -1 : 0,
      thrust: true,
      fire: true,
      fireHoming: i % 4 === 0,
    })
  }

  for (let t = 0; t < 120; t += 1) {
    world.step(TICK_DT, inputs)
  }

  const gc = createGcTracker()
  const durations: number[] = []
  let maxEntities = 0

  for (let t = 0; t < ticks; t += 1) {
    const t0 = performance.now()
    world.step(TICK_DT, inputs)
    const snap = world.getSnapshot(asSeq(t))
    binaryCodec.encodeSnapshot(snap)
    const dt = performance.now() - t0
    durations.push(dt)
    if (snap.entities.length > maxEntities) maxEntities = snap.entities.length
  }

  const gcStats = await gc.stop()
  const stats = summarize(durations)
  const pool = world.getPoolStats()

  return {
    mode: collisionMode,
    ships: shipCount,
    maxEntities,
    ...stats,
    bulletsReused: pool.bulletsReused,
    gcCount: gcStats.count,
    gcMaxMs: gcStats.maxMs,
  }
}

async function benchClientHotPath30s() {
  const serverWorld = new MatchWorld({ seed: 777, targetAsteroids: 10 })
  const inputs = new Map<EntityId, StepInput>()
  for (let i = 1; i <= 9; i += 1) {
    const id = asEntityId(i)
    serverWorld.addShip(id)
    inputs.set(id, {
      turn: i % 2 === 0 ? 1 : -1,
      thrust: true,
      fire: true,
      fireHoming: i % 3 === 0,
    })
  }

  const netWorld = new NetWorld()
  netWorld.setWelcome({ shipId: asEntityId(1), tick: asTick(0) })

  for (let t = 0; t < 90; t += 1) {
    const evts = serverWorld.step(TICK_DT, inputs)
    const encoded = binaryCodec.encodeSnapshot(
      serverWorld.getSnapshot(asSeq(t)),
    )
    if (encoded instanceof ArrayBuffer) {
      netWorld.onBinarySnapshot(encoded, t * 33.33)
    }
    netWorld.onServerEvents(evts)
    netWorld.stepLocal(
      { turn: 1, thrust: true, fire: true, fireHoming: false },
      TICK_DT,
    )
    netWorld.getRenderState(t * 33.33, 0.5)
  }

  const gc = createGcTracker()
  const heapBefore = process.memoryUsage().heapUsed
  const frameDurations: number[] = []
  let seq = 100
  let simTimeMs = 3000

  for (let tick = 0; tick < 900; tick += 1) {
    const evts = serverWorld.step(TICK_DT, inputs)
    const rawSnap = binaryCodec.encodeSnapshot(
      serverWorld.getSnapshot(asSeq(seq++)),
    )

    for (let sub = 0; sub < 2; sub += 1) {
      simTimeMs += 16.6667
      const t0 = performance.now()
      if (sub === 0) {
        if (rawSnap instanceof ArrayBuffer) {
          netWorld.onBinarySnapshot(rawSnap, simTimeMs)
        }
        netWorld.onServerEvents(evts)
        netWorld.stepLocal(
          {
            turn: tick % 40 < 20 ? 1 : -1,
            thrust: true,
            fire: tick % 2 === 0,
            fireHoming: tick % 15 === 0,
          },
          TICK_DT,
        )
      }
      netWorld.getRenderState(simTimeMs, sub * 0.5)
      frameDurations.push(performance.now() - t0)
    }
  }

  const heapDeltaKb = Number(
    ((process.memoryUsage().heapUsed - heapBefore) / 1024).toFixed(1),
  )
  const gcStats = await gc.stop()
  const stats = summarize(frameDurations)
  const pools = netWorld.getPoolStats()

  return {
    scenario: '1 player + 8 bots (30s @ 60Hz, pooled)',
    ...stats,
    heapDeltaKb,
    gcCount: gcStats.count,
    gcMaxMs: gcStats.maxMs,
    bulletsReused: pools.predictedBulletsReused,
    particlesReused: pools.particlesReused,
  }
}

console.log(
  '=== Client Hot-Path Benchmark AFTER (Pooled NetWorld + Zero-Alloc Binary Decode) ===',
)
console.table([await benchClientHotPath30s()])

console.log(
  '\n=== Server MatchWorld: SpatialHashGrid vs Naive O(n^2) (900 ticks each) ===',
)
const serverRows = []
for (const n of [8, 32, 64, 128]) {
  serverRows.push(await benchServerMatchWorld(n, 'naive', 900))
  serverRows.push(await benchServerMatchWorld(n, 'spatial', 900))
}
console.table(serverRows)
