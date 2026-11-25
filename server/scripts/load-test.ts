import { spawn, type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { BotClient } from '../src/bot.ts'

const PORT = 3199
const BASE_HTTP = `http://127.0.0.1:${PORT}`
const BASE_WS = `ws://127.0.0.1:${PORT}/ws`
const BOTS_PER_ROOM = 8
const MEASURE_DURATION_MS = 5000
const TICK_BUDGET_MS = 33.33

interface ServerMatchStat {
  readonly roomId: string
  readonly running: boolean
  readonly totalTicks: number
  readonly overruns: number
  readonly durationMs: {
    readonly p50: number
    readonly p95: number
    readonly p99: number
  }
  readonly jitterMs: {
    readonly p50: number
    readonly p99: number
  }
}

interface ServerStatsResponse {
  readonly rssMb: number
  readonly heapUsedMb: number
  readonly rooms: number
  readonly players: number
  readonly matches: readonly ServerMatchStat[]
}

interface LoadLevelResult {
  readonly clients: number
  readonly connected: number
  readonly rooms: number
  readonly tickP50Ms: number
  readonly tickP95Ms: number
  readonly tickP99Ms: number
  readonly aggTickWorkMs: number
  readonly jitterP99Ms: number
  readonly overruns: number
  readonly rssMb: number
  readonly heapMb: number
  readonly status: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForHealth(timeoutMs = 15_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    try {
      const res = await fetch(`${BASE_HTTP}/health`)
      if (res.ok) return
    } catch {
      // server starting up
    }
    await sleep(150)
  }
  throw new Error('Timed out waiting for load-test server /health')
}

async function createRoom(name: string): Promise<string> {
  const res = await fetch(`${BASE_HTTP}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, difficulty: 'Normal' }),
  })
  if (!res.ok) {
    throw new Error(`Failed to create room "${name}": HTTP ${res.status}`)
  }
  const data: unknown = await res.json()
  if (
    typeof data === 'object' &&
    data !== null &&
    'id' in data &&
    typeof data.id === 'string'
  ) {
    return data.id
  }
  throw new Error('Invalid room creation response')
}

function isServerStats(value: unknown): value is ServerStatsResponse {
  if (typeof value !== 'object' || value === null) return false
  return (
    'rssMb' in value &&
    'heapUsedMb' in value &&
    'rooms' in value &&
    'players' in value &&
    'matches' in value &&
    Array.isArray(value.matches)
  )
}

async function fetchStats(): Promise<ServerStatsResponse> {
  const res = await fetch(`${BASE_HTTP}/api/stats`)
  if (!res.ok) throw new Error(`Stats failed: HTTP ${res.status}`)
  const data: unknown = await res.json()
  if (!isServerStats(data)) throw new Error('Invalid /api/stats response')
  return data
}

async function runLevel(
  clientCount: number,
  runIndex: number,
): Promise<LoadLevelResult> {
  const roomCount = Math.ceil(clientCount / BOTS_PER_ROOM)
  const roomIds: string[] = []
  for (let r = 0; r < roomCount; r += 1) {
    const id = await createRoom(`load-${runIndex}-${r + 1}`)
    roomIds.push(id)
  }

  const bots: BotClient[] = []
  for (let i = 0; i < clientCount; i += 1) {
    const roomId = roomIds[Math.floor(i / BOTS_PER_ROOM)]
    if (!roomId) continue
    bots.push(
      new BotClient({
        url: BASE_WS,
        room: roomId,
        name: `L${clientCount}-${i + 1}`,
      }),
    )
  }

  // Connect in batches of 16 to avoid local TCP backlog spikes
  let connected = 0
  for (let i = 0; i < bots.length; i += 16) {
    const batch = bots.slice(i, i + 16)
    const results = await Promise.allSettled(batch.map((b) => b.connect()))
    for (const r of results) {
      if (r.status === 'fulfilled') connected += 1
    }
  }

  // Let all matches reach steady state and accumulate ~150 ticks per room
  await sleep(MEASURE_DURATION_MS)
  const stats = await fetchStats()

  const activeMatches = stats.matches.filter(
    (m) => m.running && roomIds.includes(m.roomId),
  )

  let sumP50 = 0
  let maxP95 = 0
  let maxP99 = 0
  let maxJitterP99 = 0
  let totalOverruns = 0

  for (const m of activeMatches) {
    sumP50 += m.durationMs.p50
    if (m.durationMs.p95 > maxP95) maxP95 = m.durationMs.p95
    if (m.durationMs.p99 > maxP99) maxP99 = m.durationMs.p99
    if (m.jitterMs.p99 > maxJitterP99) maxJitterP99 = m.jitterMs.p99
    totalOverruns += m.overruns
  }

  const avgP50 = activeMatches.length > 0 ? sumP50 / activeMatches.length : 0
  const aggTickWorkMs = sumP50
  const exceeded =
    maxP99 > TICK_BUDGET_MS ||
    aggTickWorkMs > TICK_BUDGET_MS ||
    maxJitterP99 > TICK_BUDGET_MS ||
    totalOverruns > 0

  for (const b of bots) {
    b.disconnect()
  }
  await sleep(700)

  return {
    clients: clientCount,
    connected,
    rooms: activeMatches.length,
    tickP50Ms: Number(avgP50.toFixed(3)),
    tickP95Ms: Number(maxP95.toFixed(3)),
    tickP99Ms: Number(maxP99.toFixed(3)),
    aggTickWorkMs: Number(aggTickWorkMs.toFixed(2)),
    jitterP99Ms: Number(maxJitterP99.toFixed(2)),
    overruns: totalOverruns,
    rssMb: stats.rssMb,
    heapMb: stats.heapUsedMb,
    status: exceeded ? '> 33.3 ms budget' : 'OK (< 33.3 ms)',
  }
}

const serverRoot = path.resolve(import.meta.dirname, '..')
const loadLogDir = path.join(serverRoot, 'logs-load')

const child: ChildProcess = spawn(
  process.execPath,
  ['--import', 'tsx', 'src/index.ts'],
  {
    cwd: serverRoot,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      LOG_DIR: 'logs-load',
      MAX_ROOMS: '120',
      MAX_PLAYERS_PER_ROOM: '16',
      RATE_LIMIT_PER_SEC: '200',
      SLOW_CLIENT_THRESHOLD_BYTES: '262144',
      ENABLE_SLOW_DEMO: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)

try {
  await waitForHealth()
  console.log(
    `[LoadTest] Dedicated server online at ${BASE_HTTP} (${BOTS_PER_ROOM} bots/room, ${MEASURE_DURATION_MS / 1000}s per level)`,
  )

  const tiers = [8, 32, 64, 128, 256, 320]
  const results: LoadLevelResult[] = []

  for (let i = 0; i < tiers.length; i += 1) {
    const count = tiers[i]
    if (!count) continue
    console.log(`[LoadTest] Running ${count} headless WS bots...`)
    const row = await runLevel(count, i + 1)
    results.push(row)
    console.log(
      `  -> connected=${row.connected}/${row.clients}, rooms=${row.rooms}, tick p99=${row.tickP99Ms}ms, agg=${row.aggTickWorkMs}ms, jitter p99=${row.jitterP99Ms}ms, overruns=${row.overruns}, RSS=${row.rssMb}MB [${row.status}]`,
    )
  }

  console.log('\n=== Headless Load-Test Summary ===')
  console.table(results)

  const thresholdRow = results.find((r) => r.status !== 'OK (< 33.3 ms)')
  if (thresholdRow) {
    console.log(
      `\nThreshold exceeded (> 33.3 ms tick budget) at ${thresholdRow.clients} concurrent clients.`,
    )
  } else {
    console.log(
      `\nAll tested levels up to ${tiers[tiers.length - 1]} clients stayed within 33.3 ms tick budget!`,
    )
  }
} finally {
  child.kill('SIGTERM')
  await sleep(400)
  if (!child.killed) child.kill('SIGKILL')
  await rm(loadLogDir, { recursive: true, force: true })
}
