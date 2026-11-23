import {
  MatchWorld,
  TICK_DT,
  TICK_MS,
  TICK_RATE,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  asSeq,
  type EntityId,
  type InputCommand,
  type MatchEvent,
  type Seq,
  type Snapshot,
  type Tick,
} from '@dogfight/shared'
import type { Room } from './rooms.ts'

export interface TickBroadcastPayload {
  readonly room: Room
  readonly baseSnapshot: Snapshot
  readonly lastProcessedSeqByShip: ReadonlyMap<EntityId, Seq>
  readonly events: readonly MatchEvent[]
}

export interface MatchStats {
  readonly roomId: string
  readonly running: boolean
  readonly tickRate: number
  readonly tick: Tick
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

type HeldInput = Pick<InputCommand, 'turn' | 'thrust' | 'fire' | 'fireHoming'>

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  return sorted[idx] ?? 0
}

export class Match {
  #room: Room
  #world: MatchWorld
  #onTickBroadcast?: (payload: TickBroadcastPayload) => void
  #running = false
  #timer: ReturnType<typeof setTimeout> | null = null
  #nextTickAt = 0
  #inputQueues = new Map<EntityId, InputCommand[]>()
  #lastInput = new Map<EntityId, HeldInput>()
  #lastProcessedSeq = new Map<EntityId, Seq>()

  #tickDurations: number[] = []
  #tickJitters: number[] = []
  #totalTicks = 0
  #overruns = 0

  readonly seed: number

  constructor(
    room: Room,
    {
      onTickBroadcast,
      seed,
    }: {
      onTickBroadcast?: (payload: TickBroadcastPayload) => void
      seed?: number
    } = {},
  ) {
    this.#room = room
    this.#onTickBroadcast = onTickBroadcast
    this.seed = seed ?? Date.now() & 0x7fffffff
    this.#world = new MatchWorld({
      seed: this.seed,
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      targetAsteroids: room.arena.targetAsteroids,
      homingEvery: room.arena.homingEvery,
    })
  }

  get tick(): Tick {
    return this.#world.currentTick
  }

  addPlayer(shipId: EntityId): void {
    this.#world.addShip(shipId)
    this.#inputQueues.set(shipId, [])
    this.#lastInput.set(shipId, {
      turn: 0,
      thrust: false,
      fire: false,
      fireHoming: false,
    })
    this.#lastProcessedSeq.set(shipId, asSeq(0))
    if (!this.#running) this.start()
  }

  removePlayer(shipId: EntityId): void {
    this.#world.removeShip(shipId)
    this.#inputQueues.delete(shipId)
    this.#lastInput.delete(shipId)
    this.#lastProcessedSeq.delete(shipId)
    if (this.#room.playerCount === 0) this.stop()
  }

  enqueueInput(shipId: EntityId, input: InputCommand): void {
    const queue = this.#inputQueues.get(shipId)
    if (!queue) return
    const lastSeq = this.#lastProcessedSeq.get(shipId) ?? asSeq(0)
    if (input.seq <= lastSeq) return

    if (queue.length >= 10) queue.shift()
    queue.push(input)
    queue.sort((a, b) => a.seq - b.seq)
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#nextTickAt = performance.now() + TICK_MS
    this.#scheduleNext()
  }

  stop(): void {
    this.#running = false
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  getStats(): MatchStats {
    const sortedDur = [...this.#tickDurations].sort((a, b) => a - b)
    const sortedJit = [...this.#tickJitters].sort((a, b) => a - b)
    return {
      roomId: this.#room.id,
      running: this.#running,
      tickRate: TICK_RATE,
      tick: this.#world.currentTick,
      totalTicks: this.#totalTicks,
      overruns: this.#overruns,
      durationMs: {
        p50: Number(percentile(sortedDur, 0.5).toFixed(3)),
        p95: Number(percentile(sortedDur, 0.95).toFixed(3)),
        p99: Number(percentile(sortedDur, 0.99).toFixed(3)),
      },
      jitterMs: {
        p50: Number(percentile(sortedJit, 0.5).toFixed(3)),
        p99: Number(percentile(sortedJit, 0.99).toFixed(3)),
      },
    }
  }

  #scheduleNext(): void {
    if (!this.#running) return
    const delay = Math.max(0, this.#nextTickAt - performance.now())
    this.#timer = setTimeout(() => this.#runTick(), delay)
  }

  #runTick(): void {
    if (!this.#running) return

    const now = performance.now()
    const jitter = Math.abs(now - this.#nextTickAt)

    const inputsByShip = new Map<EntityId, HeldInput>()
    for (const [shipId, queue] of this.#inputQueues) {
      let next = queue.shift()
      if (next) {
        while (queue.length > 3) {
          const newer = queue.shift()
          if (newer) next = newer
        }
        this.#lastProcessedSeq.set(shipId, next.seq)
        this.#lastInput.set(shipId, {
          turn: next.turn,
          thrust: next.thrust,
          fire: false,
          fireHoming: false,
        })
        inputsByShip.set(shipId, next)
      } else {
        const held = this.#lastInput.get(shipId)
        if (held) inputsByShip.set(shipId, held)
      }
    }

    const events = this.#world.step(TICK_DT, inputsByShip)
    const baseSnapshot = this.#world.getSnapshot(asSeq(0))

    this.#onTickBroadcast?.({
      room: this.#room,
      baseSnapshot,
      lastProcessedSeqByShip: this.#lastProcessedSeq,
      events,
    })

    const duration = performance.now() - now
    this.#totalTicks += 1
    if (duration > TICK_MS) this.#overruns += 1

    this.#tickDurations.push(duration)
    this.#tickJitters.push(jitter)
    if (this.#tickDurations.length > 300) this.#tickDurations.shift()
    if (this.#tickJitters.length > 300) this.#tickJitters.shift()

    this.#nextTickAt += TICK_MS
    if (this.#nextTickAt < performance.now() - 250) {
      this.#nextTickAt = performance.now() + TICK_MS
    }

    this.#scheduleNext()
  }
}
