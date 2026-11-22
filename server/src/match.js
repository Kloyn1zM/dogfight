import {
  MatchWorld,
  TICK_DT,
  TICK_MS,
  TICK_RATE,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from '@dogfight/shared'

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  return sorted[idx]
}

/**
 * Авторитетний матч на сервері (30 Hz).
 * Використовує абсолютний цільовий таймер (nextTick += TICK_MS) замість setInterval,
 * щоб уникнути дрейфу й злипання тиків.
 */
export class Match {
  #room
  #world
  #onTickBroadcast
  #running = false
  #timer = null
  #nextTickAt = 0
  #inputQueues = new Map()
  #lastInput = new Map()
  #lastProcessedSeq = new Map()

  #tickDurations = []
  #tickJitters = []
  #totalTicks = 0
  #overruns = 0

  constructor(room, { onTickBroadcast, seed } = {}) {
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

  get tick() {
    return this.#world.tick
  }

  addPlayer(shipId) {
    this.#world.addShip(shipId)
    this.#inputQueues.set(shipId, [])
    this.#lastInput.set(shipId, {
      turn: 0,
      thrust: false,
      fire: false,
      fireHoming: false,
    })
    this.#lastProcessedSeq.set(shipId, 0)
    if (!this.#running) this.start()
  }

  removePlayer(shipId) {
    this.#world.removeShip(shipId)
    this.#inputQueues.delete(shipId)
    this.#lastInput.delete(shipId)
    this.#lastProcessedSeq.delete(shipId)
    if (this.#room.playerCount === 0) this.stop()
  }

  enqueueInput(shipId, input) {
    const queue = this.#inputQueues.get(shipId)
    if (!queue) return
    const lastSeq = this.#lastProcessedSeq.get(shipId) || 0
    if (input.seq <= lastSeq) return

    // Обмежуємо чергу, щоб старі пакети не накопичували затримку
    if (queue.length >= 10) queue.shift()
    queue.push(input)
    queue.sort((a, b) => a.seq - b.seq)
  }

  start() {
    if (this.#running) return
    this.#running = true
    this.#nextTickAt = performance.now() + TICK_MS
    this.#scheduleNext()
  }

  stop() {
    this.#running = false
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  getStats() {
    const sortedDur = [...this.#tickDurations].sort((a, b) => a - b)
    const sortedJit = [...this.#tickJitters].sort((a, b) => a - b)
    return {
      roomId: this.#room.id,
      running: this.#running,
      tickRate: TICK_RATE,
      tick: this.#world.tick,
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

  #scheduleNext() {
    if (!this.#running) return
    const delay = Math.max(0, this.#nextTickAt - performance.now())
    this.#timer = setTimeout(() => this.#runTick(), delay)
  }

  #runTick() {
    if (!this.#running) return

    const now = performance.now()
    const jitter = Math.abs(now - this.#nextTickAt)

    const inputsByShip = new Map()
    for (const [shipId, queue] of this.#inputQueues) {
      if (queue.length > 0) {
        // Беремо один крок керування на один 30 Hz тик (якщо черга > 3, доганяємо)
        let next = queue.shift()
        while (queue.length > 3) {
          next = queue.shift()
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
        // Якщо пакет затримався/втратився — тримаємо рух без повторних пострілів
        inputsByShip.set(shipId, this.#lastInput.get(shipId))
      }
    }

    const events = this.#world.step(TICK_DT, inputsByShip)
    const baseSnapshot = this.#world.getSnapshot(0)

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

    // Абсолютна ціль наступного тику
    this.#nextTickAt += TICK_MS
    if (this.#nextTickAt < performance.now() - 250) {
      this.#nextTickAt = performance.now() + TICK_MS
    }

    this.#scheduleNext()
  }
}
