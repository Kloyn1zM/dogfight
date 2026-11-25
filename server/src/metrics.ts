import { performance, type EventLoopUtilization } from 'node:perf_hooks'
import type { MatchStats } from './match.ts'

export interface MetricsInput {
  readonly players: number
  readonly rooms: number
  readonly wsConnections: number
  readonly droppedSlowMessages: number
  readonly matches: readonly MatchStats[]
}

export interface ServerMetricsSnapshot {
  readonly uptimeSec: number
  readonly players: number
  readonly rooms: number
  readonly wsConnections: number
  readonly droppedSlowMessages: number
  readonly messagesInPerSec: number
  readonly messagesOutPerSec: number
  readonly bytesInPerSec: number
  readonly bytesOutPerSec: number
  readonly tickDurationMs: {
    readonly p50: number
    readonly p95: number
    readonly p99: number
  }
  readonly eventLoopUtilization: number
  readonly memory: {
    readonly rssBytes: number
    readonly heapUsedBytes: number
    readonly heapTotalBytes: number
  }
}

export class MetricsCollector {
  #msgInAccum = 0
  #msgOutAccum = 0
  #bytesInAccum = 0
  #bytesOutAccum = 0

  #msgInPerSec = 0
  #msgOutPerSec = 0
  #bytesInPerSec = 0
  #bytesOutPerSec = 0

  #prevElu: EventLoopUtilization = performance.eventLoopUtilization()
  #eluRatio = 0
  #timer: ReturnType<typeof setInterval> | null = null

  start(): void {
    if (this.#timer) return
    this.#prevElu = performance.eventLoopUtilization()
    this.#timer = setInterval(() => {
      this.#msgInPerSec = this.#msgInAccum
      this.#msgOutPerSec = this.#msgOutAccum
      this.#bytesInPerSec = this.#bytesInAccum
      this.#bytesOutPerSec = this.#bytesOutAccum
      this.#msgInAccum = 0
      this.#msgOutAccum = 0
      this.#bytesInAccum = 0
      this.#bytesOutAccum = 0

      const current = performance.eventLoopUtilization()
      const delta = performance.eventLoopUtilization(current, this.#prevElu)
      this.#prevElu = current
      this.#eluRatio = Number(delta.utilization.toFixed(4))
    }, 1000)
    this.#timer.unref()
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  recordMessageIn(bytes: number): void {
    this.#msgInAccum += 1
    this.#bytesInAccum += bytes
  }

  recordMessageOut(bytes: number): void {
    this.#msgOutAccum += 1
    this.#bytesOutAccum += bytes
  }

  getSnapshot(input: MetricsInput): ServerMetricsSnapshot {
    const mem = process.memoryUsage()
    let maxP50 = 0
    let maxP95 = 0
    let maxP99 = 0
    for (const m of input.matches) {
      if (m.durationMs.p50 > maxP50) maxP50 = m.durationMs.p50
      if (m.durationMs.p95 > maxP95) maxP95 = m.durationMs.p95
      if (m.durationMs.p99 > maxP99) maxP99 = m.durationMs.p99
    }

    return {
      uptimeSec: Number(process.uptime().toFixed(1)),
      players: input.players,
      rooms: input.rooms,
      wsConnections: input.wsConnections,
      droppedSlowMessages: input.droppedSlowMessages,
      messagesInPerSec: this.#msgInPerSec,
      messagesOutPerSec: this.#msgOutPerSec,
      bytesInPerSec: this.#bytesInPerSec,
      bytesOutPerSec: this.#bytesOutPerSec,
      tickDurationMs: {
        p50: maxP50,
        p95: maxP95,
        p99: maxP99,
      },
      eventLoopUtilization: this.#eluRatio,
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
      },
    }
  }

  formatPrometheus(input: MetricsInput): string {
    const s = this.getSnapshot(input)
    return [
      '# HELP dogfight_players Active players across all rooms',
      '# TYPE dogfight_players gauge',
      `dogfight_players ${s.players}`,
      '# HELP dogfight_rooms Active rooms on this server process',
      '# TYPE dogfight_rooms gauge',
      `dogfight_rooms ${s.rooms}`,
      '# HELP dogfight_ws_connections Open WebSocket connections',
      '# TYPE dogfight_ws_connections gauge',
      `dogfight_ws_connections ${s.wsConnections}`,
      '# HELP dogfight_messages_in_per_sec Incoming WebSocket messages per second',
      '# TYPE dogfight_messages_in_per_sec gauge',
      `dogfight_messages_in_per_sec ${s.messagesInPerSec}`,
      '# HELP dogfight_messages_out_per_sec Outgoing WebSocket messages per second',
      '# TYPE dogfight_messages_out_per_sec gauge',
      `dogfight_messages_out_per_sec ${s.messagesOutPerSec}`,
      '# HELP dogfight_bytes_in_per_sec Incoming WebSocket bytes per second',
      '# TYPE dogfight_bytes_in_per_sec gauge',
      `dogfight_bytes_in_per_sec ${s.bytesInPerSec}`,
      '# HELP dogfight_bytes_out_per_sec Outgoing WebSocket bytes per second',
      '# TYPE dogfight_bytes_out_per_sec gauge',
      `dogfight_bytes_out_per_sec ${s.bytesOutPerSec}`,
      '# HELP dogfight_tick_duration_ms Worst room simulation tick duration in milliseconds',
      '# TYPE dogfight_tick_duration_ms gauge',
      `dogfight_tick_duration_ms{quantile="0.5"} ${s.tickDurationMs.p50}`,
      `dogfight_tick_duration_ms{quantile="0.95"} ${s.tickDurationMs.p95}`,
      `dogfight_tick_duration_ms{quantile="0.99"} ${s.tickDurationMs.p99}`,
      '# HELP dogfight_event_loop_utilization Node.js event loop utilization ratio (0..1)',
      '# TYPE dogfight_event_loop_utilization gauge',
      `dogfight_event_loop_utilization ${s.eventLoopUtilization}`,
      '# HELP dogfight_memory_rss_bytes Process resident set size in bytes',
      '# TYPE dogfight_memory_rss_bytes gauge',
      `dogfight_memory_rss_bytes ${s.memory.rssBytes}`,
      '# HELP dogfight_memory_heap_used_bytes V8 heap used in bytes',
      '# TYPE dogfight_memory_heap_used_bytes gauge',
      `dogfight_memory_heap_used_bytes ${s.memory.heapUsedBytes}`,
      '# HELP dogfight_dropped_slow_messages_total Non-critical messages dropped for slow clients',
      '# TYPE dogfight_dropped_slow_messages_total counter',
      `dogfight_dropped_slow_messages_total ${s.droppedSlowMessages}`,
      '',
    ].join('\n')
  }
}
