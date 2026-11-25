import {
  BULLET_RADIUS,
  FIRE_COOLDOWN,
  HOMING_COOLDOWN,
  ObjectPool,
  RAPID_FIRE_COOLDOWN,
  TICK_DT,
  TypedBus,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  asEntityId,
  asSeq,
  asTick,
  assertNever,
  cloneShipState,
  copyShipState,
  createReusableSnapshotBuffer,
  createShipState,
  decodeSnapshotBinaryInto,
  integrateShip,
  normalizeAngle,
  shortestAngleDiff,
  wrapPosition,
  type EntityId,
  type InputCommand,
  type MatchEvent,
  type PickupEffect,
  type ReusableSnapshotBuffer,
  type RosterEntry,
  type ShipSnapshot,
  type ShipState,
  type Snapshot,
  type SnapshotEntity,
  type Tick,
  type TurnDirection,
} from '@dogfight/shared'

export interface LocalCommandInput {
  readonly turn: TurnDirection
  readonly thrust: boolean
  readonly fire: boolean
  readonly fireHoming: boolean
}

export type GameEvents = {
  fired: { ownerId: EntityId; homing: boolean }
  hit: { x: number; y: number }
  pickup: { effect: PickupEffect }
  exploded: { kind: 'ship' | 'asteroid'; big: boolean; x: number; y: number }
  score: { delta: number; total: number }
}

export interface RenderShip {
  readonly kind: 'ship'
  readonly id: EntityId
  readonly isLocal: boolean
  readonly name: string
  readonly x: number
  readonly y: number
  readonly angle: number
  readonly radius: number
  readonly thrusting: boolean
  readonly shieldActive: boolean
  readonly rapidFireActive: boolean
  readonly hp: number
  readonly score: number
}

export interface RenderBullet {
  readonly kind: 'bullet'
  readonly id: EntityId | string
  readonly x: number
  readonly y: number
  readonly angle: number
  readonly isHoming: boolean
  readonly predicted?: boolean
}

export interface RenderAsteroid {
  readonly kind: 'asteroid'
  readonly id: EntityId
  readonly x: number
  readonly y: number
  readonly angle: number
  readonly isHoming: boolean
  readonly radius: number
}

export interface RenderPickup {
  readonly kind: 'pickup'
  readonly id: EntityId
  readonly x: number
  readonly y: number
  readonly angle: number
  readonly effect: PickupEffect
  readonly radius: number
}

export type RenderEntity =
  RenderShip | RenderBullet | RenderAsteroid | RenderPickup

interface MutableRenderShip {
  kind: 'ship'
  id: EntityId
  isLocal: boolean
  name: string
  x: number
  y: number
  angle: number
  radius: number
  thrusting: boolean
  shieldActive: boolean
  rapidFireActive: boolean
  hp: number
  score: number
}

interface MutableRenderBullet {
  kind: 'bullet'
  id: EntityId | string
  x: number
  y: number
  angle: number
  isHoming: boolean
  predicted: boolean
}

interface MutableRenderAsteroid {
  kind: 'asteroid'
  id: EntityId
  x: number
  y: number
  angle: number
  isHoming: boolean
  radius: number
}

interface MutableRenderPickup {
  kind: 'pickup'
  id: EntityId
  x: number
  y: number
  angle: number
  effect: PickupEffect
  radius: number
}

export interface ExplosionParticle {
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

export interface RenderExplosion {
  ttl: number
  maxTtl: number
  color: string
  readonly particles: ExplosionParticle[]
}

export interface RenderState {
  readonly entities: readonly RenderEntity[]
  readonly explosions: readonly RenderExplosion[]
}

export interface NetWorldMetrics {
  readonly tick: number
  readonly snapshotAgeMs: number
  readonly pendingInputs: number
  readonly lastCorrectionPx: number
  readonly maxCorrectionPx: number
  readonly bufferSize: number
}

export interface NetWorldPoolStats {
  readonly predictedBulletsCreated: number
  readonly predictedBulletsReused: number
  readonly particlesCreated: number
  readonly particlesReused: number
  readonly explosionsCreated: number
  readonly explosionsReused: number
}

interface BufferedSnapshotSlot {
  receivedAt: number
  snapshot: Snapshot
  readonly decodeBuf: ReusableSnapshotBuffer
  readonly byId: Map<EntityId, SnapshotEntity>
}

interface PredictedBullet {
  tempId: string
  x: number
  y: number
  prevX: number
  prevY: number
  vx: number
  vy: number
  angle: number
  radius: number
  isHoming: boolean
  ttl: number
}

const SNAPSHOT_BUFFER_CAPACITY = 24

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpAngle(from: number, to: number, t: number): number {
  return normalizeAngle(from + shortestAngleDiff(from, to) * t)
}

function wrapDelta(delta: number, size: number): number {
  let d = delta
  if (d > size / 2) d -= size
  else if (d < -size / 2) d += size
  return d
}

export class NetWorld {
  readonly events = new TypedBus<GameEvents>()

  #snapshotPool: BufferedSnapshotSlot[] = []
  #snapshotBuffer: BufferedSnapshotSlot[] = []
  #pendingInputs: InputCommand[] = []
  #predictedBullets: PredictedBullet[] = []
  #explosions: RenderExplosion[] = []
  #rosterByShipId = new Map<EntityId, string>()

  #predictedBulletPool = new ObjectPool<PredictedBullet>(
    () => ({
      tempId: '',
      x: 0,
      y: 0,
      prevX: 0,
      prevY: 0,
      vx: 0,
      vy: 0,
      angle: 0,
      radius: BULLET_RADIUS,
      isHoming: false,
      ttl: 0,
    }),
    { initialSize: 32, maxSize: 256 },
  )

  #particlePool = new ObjectPool<ExplosionParticle>(
    () => ({ x: 0, y: 0, vx: 0, vy: 0, r: 2 }),
    { initialSize: 128, maxSize: 1024 },
  )

  #explosionPool = new ObjectPool<RenderExplosion>(
    () => ({ ttl: 0, maxTtl: 0.5, color: '#fb923c', particles: [] }),
    {
      initialSize: 16,
      maxSize: 128,
      reset(ex) {
        ex.particles.length = 0
      },
    },
  )

  // Перевикористовувані буфери для getRenderState (0 алокацій на кадр у steady-state)
  #renderEntities: RenderEntity[] = []
  #renderShips: MutableRenderShip[] = []
  #renderBullets: MutableRenderBullet[] = []
  #renderAsteroids: MutableRenderAsteroid[] = []
  #renderPickups: MutableRenderPickup[] = []
  #renderState: RenderState

  #localShip: ShipState | null = null
  #prevLocalShip: ShipState | null = null
  #errorX = 0
  #errorY = 0
  #errorAngle = 0

  #nextSeq = 1
  #nextTempBulletId = 1
  #latestServerTick = 0
  #lastSnapshotAt = 0
  #lastScore = 0
  #lastCorrectionPx = 0
  #maxCorrectionPx = 0

  myShipId: EntityId | null = null
  predictionEnabled = true
  interpolationDelayMs = 80
  breakDeterminism = false

  constructor() {
    this.#renderState = {
      entities: this.#renderEntities,
      explosions: this.#explosions,
    }
    for (let i = 0; i < SNAPSHOT_BUFFER_CAPACITY + 2; i += 1) {
      const decodeBuf = createReusableSnapshotBuffer()
      this.#snapshotPool.push({
        receivedAt: 0,
        snapshot: decodeBuf,
        decodeBuf,
        byId: new Map(),
      })
    }
  }

  reset(): void {
    while (this.#snapshotBuffer.length > 0) {
      const slot = this.#snapshotBuffer.pop()
      if (slot) {
        slot.byId.clear()
        this.#snapshotPool.push(slot)
      }
    }
    this.#pendingInputs.length = 0
    while (this.#predictedBullets.length > 0) {
      const pb = this.#predictedBullets.pop()
      if (pb) this.#predictedBulletPool.release(pb)
    }
    while (this.#explosions.length > 0) {
      const ex = this.#explosions.pop()
      if (ex) this.#releaseExplosion(ex)
    }
    this.#rosterByShipId.clear()

    this.myShipId = null
    this.#localShip = null
    this.#prevLocalShip = null
    this.#errorX = 0
    this.#errorY = 0
    this.#errorAngle = 0
    this.#nextSeq = 1
    this.#latestServerTick = 0
    this.#lastSnapshotAt = 0
    this.#lastScore = 0
    this.#lastCorrectionPx = 0
    this.#maxCorrectionPx = 0
  }

  setWelcome({ shipId, tick }: { shipId: EntityId; tick: Tick }): void {
    this.myShipId = shipId
    this.#latestServerTick = tick
    this.#pendingInputs.length = 0
    while (this.#predictedBullets.length > 0) {
      const pb = this.#predictedBullets.pop()
      if (pb) this.#predictedBulletPool.release(pb)
    }
    this.#localShip = null
    this.#prevLocalShip = null
    this.#errorX = 0
    this.#errorY = 0
    this.#errorAngle = 0
    this.#lastScore = 0
  }

  setRoster(players: readonly RosterEntry[]): void {
    this.#rosterByShipId.clear()
    for (const p of players) {
      this.#rosterByShipId.set(p.shipId, p.name)
    }
  }

  getPlayerName(shipId: EntityId): string {
    return this.#rosterByShipId.get(shipId) ?? `Pilot #${shipId}`
  }

  getLocalShip(): ShipState | null {
    return this.#localShip
  }

  getMetrics(now = performance.now()): NetWorldMetrics {
    const snapshotAgeMs =
      this.#lastSnapshotAt > 0 ? Math.max(0, now - this.#lastSnapshotAt) : 0
    return {
      tick: this.#latestServerTick,
      snapshotAgeMs,
      pendingInputs: this.#pendingInputs.length,
      lastCorrectionPx: this.#lastCorrectionPx,
      maxCorrectionPx: this.#maxCorrectionPx,
      bufferSize: this.#snapshotBuffer.length,
    }
  }

  getPoolStats(): NetWorldPoolStats {
    return {
      predictedBulletsCreated: this.#predictedBulletPool.created,
      predictedBulletsReused: this.#predictedBulletPool.reused,
      particlesCreated: this.#particlePool.created,
      particlesReused: this.#particlePool.reused,
      explosionsCreated: this.#explosionPool.created,
      explosionsReused: this.#explosionPool.reused,
    }
  }

  resetCorrectionPeak(): void {
    this.#maxCorrectionPx = 0
  }

  stepLocal(command: LocalCommandInput, dt = TICK_DT): InputCommand | null {
    const smoothFactor = Math.exp(-dt / 0.085)
    this.#errorX *= smoothFactor
    this.#errorY *= smoothFactor
    this.#errorAngle *= smoothFactor
    if (Math.abs(this.#errorX) < 0.05) this.#errorX = 0
    if (Math.abs(this.#errorY) < 0.05) this.#errorY = 0
    if (Math.abs(this.#errorAngle) < 0.001) this.#errorAngle = 0

    const drag = Math.exp(-3.2 * dt)
    for (let i = this.#explosions.length - 1; i >= 0; i -= 1) {
      const ex = this.#explosions[i]
      if (!ex) continue
      const particles = ex.particles
      for (let j = 0; j < particles.length; j += 1) {
        const p = particles[j]
        if (!p) continue
        p.vx *= drag
        p.vy *= drag
        p.x += p.vx * dt
        p.y += p.vy * dt
      }
      ex.ttl -= dt
      if (ex.ttl <= 0) {
        const last = this.#explosions.pop()
        if (last && i < this.#explosions.length) {
          this.#explosions[i] = last
        }
        this.#releaseExplosion(ex)
      }
    }

    for (let i = this.#predictedBullets.length - 1; i >= 0; i -= 1) {
      const b = this.#predictedBullets[i]
      if (!b) continue
      b.prevX = b.x
      b.prevY = b.y
      b.x += b.vx * dt
      b.y += b.vy * dt
      wrapPosition(b, WORLD_WIDTH, WORLD_HEIGHT)
      b.ttl -= dt
      if (b.ttl <= 0) {
        const last = this.#predictedBullets.pop()
        if (last && i < this.#predictedBullets.length) {
          this.#predictedBullets[i] = last
        }
        this.#predictedBulletPool.release(b)
      }
    }

    if (this.myShipId === null) return null

    const input: InputCommand = {
      seq: asSeq(this.#nextSeq++),
      tick: asTick(this.#latestServerTick + 1),
      turn: command.turn,
      thrust: command.thrust,
      fire: command.fire,
      fireHoming: command.fireHoming,
    }

    if (this.#localShip) {
      if (this.#prevLocalShip) {
        copyShipState(this.#prevLocalShip, this.#localShip)
      } else {
        this.#prevLocalShip = cloneShipState(this.#localShip)
      }

      if (this.predictionEnabled && this.#localShip.alive) {
        this.#pendingInputs.push(input)
        if (this.#pendingInputs.length > 90) {
          this.#pendingInputs.shift()
        }

        this.#integrateWithOptionalBug(this.#localShip, input, dt)

        if (input.fire && this.#localShip.fireCooldown === 0) {
          this.#spawnPredictedBullet(this.#localShip, false)
          this.#localShip.fireCooldown =
            this.#localShip.rapidFireTimer > 0
              ? RAPID_FIRE_COOLDOWN
              : FIRE_COOLDOWN
        }
        if (input.fireHoming && this.#localShip.homingCooldown === 0) {
          this.#spawnPredictedBullet(this.#localShip, true)
          this.#localShip.homingCooldown = HOMING_COOLDOWN
        }
      }
    }

    return input
  }

  /**
   * Zero-allocation декодування бінарного снапшота безпосередньо в перевикористовуваний слот буфера.
   */
  onBinarySnapshot(raw: ArrayBuffer, receivedAt = performance.now()): void {
    const slot = this.#acquireSnapshotSlot()
    let decoded: Snapshot
    try {
      decoded = decodeSnapshotBinaryInto(raw, slot.decodeBuf)
    } catch (err: unknown) {
      this.#snapshotPool.push(slot)
      throw err
    }

    if (decoded.tick < this.#latestServerTick) {
      this.#snapshotPool.push(slot)
      return
    }

    slot.receivedAt = receivedAt
    slot.snapshot = decoded
    this.#ingestSnapshotSlot(slot)
  }

  onSnapshot(snapshot: Snapshot, receivedAt = performance.now()): void {
    if (snapshot.tick < this.#latestServerTick) return
    const slot = this.#acquireSnapshotSlot()
    slot.receivedAt = receivedAt
    slot.snapshot = snapshot
    this.#ingestSnapshotSlot(slot)
  }

  #acquireSnapshotSlot(): BufferedSnapshotSlot {
    const free = this.#snapshotPool.pop()
    if (free) return free
    const oldest = this.#snapshotBuffer.shift()
    if (oldest) {
      oldest.byId.clear()
      return oldest
    }
    const decodeBuf = createReusableSnapshotBuffer()
    return {
      receivedAt: 0,
      snapshot: decodeBuf,
      decodeBuf,
      byId: new Map(),
    }
  }

  #ingestSnapshotSlot(slot: BufferedSnapshotSlot): void {
    const { snapshot, receivedAt, byId } = slot

    this.#latestServerTick = snapshot.tick
    this.#lastSnapshotAt = receivedAt

    byId.clear()
    const entities = snapshot.entities
    for (let i = 0; i < entities.length; i += 1) {
      const e = entities[i]
      if (e) byId.set(e.id, e)
    }

    this.#snapshotBuffer.push(slot)
    while (this.#snapshotBuffer.length > SNAPSHOT_BUFFER_CAPACITY) {
      const recycled = this.#snapshotBuffer.shift()
      if (recycled) {
        recycled.byId.clear()
        this.#snapshotPool.push(recycled)
      }
    }

    if (this.myShipId === null) return

    for (let i = this.#predictedBullets.length - 1; i >= 0; i -= 1) {
      const pb = this.#predictedBullets[i]
      if (!pb) continue
      let matched = false
      for (let j = 0; j < entities.length; j += 1) {
        const e = entities[j]
        if (!e || e.kind !== 'bullet' || e.ownerId !== this.myShipId) continue
        const dx = wrapDelta(e.x - pb.x, WORLD_WIDTH)
        const dy = wrapDelta(e.y - pb.y, WORLD_HEIGHT)
        if (dx * dx + dy * dy <= 95 * 95) {
          matched = true
          break
        }
      }
      if (matched) {
        const last = this.#predictedBullets.pop()
        if (last && i < this.#predictedBullets.length) {
          this.#predictedBullets[i] = last
        }
        this.#predictedBulletPool.release(pb)
      }
    }

    const serverEntity = byId.get(this.myShipId)
    if (!serverEntity || serverEntity.kind !== 'ship') return

    if (serverEntity.score > this.#lastScore) {
      this.events.emit('score', {
        delta: serverEntity.score - this.#lastScore,
        total: serverEntity.score,
      })
    }
    this.#lastScore = serverEntity.score

    if (!this.#localShip) {
      this.#localShip = createShipState({
        id: serverEntity.id,
        x: serverEntity.x,
        y: serverEntity.y,
        angle: serverEntity.angle,
      })
      this.#applyAuthoritativeShip(this.#localShip, serverEntity)
      this.#prevLocalShip = cloneShipState(this.#localShip)
      return
    }

    const wasAlive = this.#localShip.alive
    const prevVisX = this.#localShip.x + this.#errorX
    const prevVisY = this.#localShip.y + this.#errorY
    const prevVisAngle = normalizeAngle(
      this.#localShip.angle + this.#errorAngle,
    )

    const ackSeq = snapshot.lastProcessedSeq
    while (this.#pendingInputs.length > 0) {
      const head = this.#pendingInputs[0]
      if (!head || head.seq > ackSeq) break
      this.#pendingInputs.shift()
    }

    this.#applyAuthoritativeShip(this.#localShip, serverEntity)

    if (!this.#localShip.alive || !wasAlive) {
      this.#pendingInputs.length = 0
      this.#errorX = 0
      this.#errorY = 0
      this.#errorAngle = 0
      this.#lastCorrectionPx = 0
      if (this.#prevLocalShip) {
        copyShipState(this.#prevLocalShip, this.#localShip)
      }
      return
    }

    if (this.predictionEnabled) {
      for (let i = 0; i < this.#pendingInputs.length; i += 1) {
        const inp = this.#pendingInputs[i]
        if (inp) this.#integrateWithOptionalBug(this.#localShip, inp, TICK_DT)
      }

      const dx = wrapDelta(prevVisX - this.#localShip.x, WORLD_WIDTH)
      const dy = wrapDelta(prevVisY - this.#localShip.y, WORLD_HEIGHT)
      const corr = Math.hypot(dx, dy)
      this.#lastCorrectionPx = corr
      if (corr > this.#maxCorrectionPx) this.#maxCorrectionPx = corr

      if (corr > 0.2 && corr < 220) {
        this.#errorX = dx
        this.#errorY = dy
        this.#errorAngle = shortestAngleDiff(
          this.#localShip.angle,
          prevVisAngle,
        )
      } else {
        this.#errorX = 0
        this.#errorY = 0
        this.#errorAngle = 0
      }
    } else {
      this.#lastCorrectionPx = 0
      this.#errorX = 0
      this.#errorY = 0
      this.#errorAngle = 0
    }

    if (this.#prevLocalShip) {
      copyShipState(this.#prevLocalShip, this.#localShip)
    }
  }

  onServerEvents(events: readonly MatchEvent[]): void {
    for (let i = 0; i < events.length; i += 1) {
      const evt = events[i]
      if (!evt) continue
      switch (evt.type) {
        case 'fired':
          this.events.emit('fired', {
            homing: evt.homing,
            ownerId: evt.ownerId,
          })
          break
        case 'hit':
          this.events.emit('hit', { x: evt.x, y: evt.y })
          break
        case 'pickup':
          if (evt.shipId === this.myShipId) {
            this.events.emit('pickup', { effect: evt.effect })
          }
          break
        case 'exploded':
          this.events.emit('exploded', {
            kind: evt.kind,
            big: evt.big,
            x: evt.x,
            y: evt.y,
          })
          this.#spawnExplosion({
            x: evt.x,
            y: evt.y,
            big: evt.big,
            color: evt.kind === 'ship' ? '#ef4444' : '#fb923c',
          })
          break
        default:
          assertNever(evt)
      }
    }
  }

  getRenderState(now: number, alpha: number): RenderState {
    const entities = this.#renderEntities
    entities.length = 0
    let shipIdx = 0
    let bulletIdx = 0
    let astIdx = 0
    let pickupIdx = 0

    const pushShip = (
      id: EntityId,
      isLocal: boolean,
      name: string,
      x: number,
      y: number,
      angle: number,
      thrusting: boolean,
      shieldActive: boolean,
      rapidFireActive: boolean,
      hp: number,
      score: number,
    ): void => {
      let slot = this.#renderShips[shipIdx]
      if (!slot) {
        slot = {
          kind: 'ship',
          id,
          isLocal,
          name,
          x,
          y,
          angle,
          radius: 14,
          thrusting,
          shieldActive,
          rapidFireActive,
          hp,
          score,
        }
        this.#renderShips.push(slot)
      }
      shipIdx += 1
      slot.id = id
      slot.isLocal = isLocal
      slot.name = name
      slot.x = x
      slot.y = y
      slot.angle = angle
      slot.thrusting = thrusting
      slot.shieldActive = shieldActive
      slot.rapidFireActive = rapidFireActive
      slot.hp = hp
      slot.score = score
      entities.push(slot)
    }

    const pushBullet = (
      id: EntityId | string,
      x: number,
      y: number,
      angle: number,
      isHoming: boolean,
      predicted: boolean,
    ): void => {
      let slot = this.#renderBullets[bulletIdx]
      if (!slot) {
        slot = { kind: 'bullet', id, x, y, angle, isHoming, predicted }
        this.#renderBullets.push(slot)
      }
      bulletIdx += 1
      slot.id = id
      slot.x = x
      slot.y = y
      slot.angle = angle
      slot.isHoming = isHoming
      slot.predicted = predicted
      entities.push(slot)
    }

    const pushAsteroid = (
      id: EntityId,
      x: number,
      y: number,
      angle: number,
      isHoming: boolean,
      radius: number,
    ): void => {
      let slot = this.#renderAsteroids[astIdx]
      if (!slot) {
        slot = { kind: 'asteroid', id, x, y, angle, isHoming, radius }
        this.#renderAsteroids.push(slot)
      }
      astIdx += 1
      slot.id = id
      slot.x = x
      slot.y = y
      slot.angle = angle
      slot.isHoming = isHoming
      slot.radius = radius
      entities.push(slot)
    }

    const pushPickup = (
      id: EntityId,
      x: number,
      y: number,
      angle: number,
      effect: PickupEffect,
      radius: number,
    ): void => {
      let slot = this.#renderPickups[pickupIdx]
      if (!slot) {
        slot = { kind: 'pickup', id, x, y, angle, effect, radius }
        this.#renderPickups.push(slot)
      }
      pickupIdx += 1
      slot.id = id
      slot.x = x
      slot.y = y
      slot.angle = angle
      slot.effect = effect
      slot.radius = radius
      entities.push(slot)
    }

    if (
      this.predictionEnabled &&
      this.#localShip &&
      this.#localShip.alive &&
      this.#prevLocalShip
    ) {
      const wrapX =
        Math.abs(this.#localShip.x - this.#prevLocalShip.x) > WORLD_WIDTH / 2
      const wrapY =
        Math.abs(this.#localShip.y - this.#prevLocalShip.y) > WORLD_HEIGHT / 2

      const baseX = wrapX
        ? this.#localShip.x
        : lerp(this.#prevLocalShip.x, this.#localShip.x, alpha)
      const baseY = wrapY
        ? this.#localShip.y
        : lerp(this.#prevLocalShip.y, this.#localShip.y, alpha)
      const baseAngle = lerpAngle(
        this.#prevLocalShip.angle,
        this.#localShip.angle,
        alpha,
      )

      const x =
        (((baseX + this.#errorX) % WORLD_WIDTH) + WORLD_WIDTH) % WORLD_WIDTH
      const y =
        (((baseY + this.#errorY) % WORLD_HEIGHT) + WORLD_HEIGHT) % WORLD_HEIGHT
      const angle = normalizeAngle(baseAngle + this.#errorAngle)

      pushShip(
        this.#localShip.id,
        true,
        this.getPlayerName(this.#localShip.id),
        x,
        y,
        angle,
        this.#localShip.thrust > 0,
        this.#localShip.shieldTimer > 0,
        this.#localShip.rapidFireTimer > 0,
        this.#localShip.hp,
        this.#localShip.score,
      )
    }

    const buf = this.#snapshotBuffer
    const first = buf[0]
    const last = buf[buf.length - 1]
    if (first && last) {
      const renderTime = now - this.interpolationDelayMs
      let s0 = first
      let s1 = last

      if (renderTime <= first.receivedAt) {
        s0 = first
        s1 = first
      } else if (renderTime >= last.receivedAt) {
        s0 = last
        s1 = last
      } else {
        for (let i = 0; i < buf.length - 1; i += 1) {
          const cur = buf[i]
          const next = buf[i + 1]
          if (
            cur &&
            next &&
            cur.receivedAt <= renderTime &&
            next.receivedAt >= renderTime
          ) {
            s0 = cur
            s1 = next
            break
          }
        }
      }

      const span = s1.receivedAt - s0.receivedAt
      const t =
        span > 0.001
          ? Math.max(0, Math.min(1, (renderTime - s0.receivedAt) / span))
          : 1

      const snapEntities = s1.snapshot.entities
      for (let i = 0; i < snapEntities.length; i += 1) {
        const e1 = snapEntities[i]
        if (!e1) continue
        const e0 = s0.byId.get(e1.id)
        let x = e1.x
        let y = e1.y
        let angle = e1.angle

        if (e0 && e0.kind === e1.kind) {
          if (Math.abs(e1.x - e0.x) <= WORLD_WIDTH / 2) {
            x = lerp(e0.x, e1.x, t)
          }
          if (Math.abs(e1.y - e0.y) <= WORLD_HEIGHT / 2) {
            y = lerp(e0.y, e1.y, t)
          }
          angle = lerpAngle(e0.angle, e1.angle, t)
        }

        switch (e1.kind) {
          case 'ship':
            if (this.predictionEnabled && e1.id === this.myShipId) continue
            if (!e1.alive) continue
            pushShip(
              e1.id,
              e1.id === this.myShipId,
              this.getPlayerName(e1.id),
              x,
              y,
              angle,
              e1.thrusting,
              e1.shieldActive,
              e1.rapidFireActive,
              e1.hp,
              e1.score,
            )
            break
          case 'bullet':
            pushBullet(e1.id, x, y, angle, e1.isHoming, false)
            break
          case 'asteroid':
            pushAsteroid(e1.id, x, y, angle, e1.isHoming, e1.radius)
            break
          case 'pickup':
            pushPickup(e1.id, x, y, angle, e1.effect, e1.radius)
            break
          default:
            assertNever(e1)
        }
      }
    }

    for (let i = 0; i < this.#predictedBullets.length; i += 1) {
      const pb = this.#predictedBullets[i]
      if (!pb) continue
      const wx = Math.abs(pb.x - pb.prevX) > WORLD_WIDTH / 2
      const wy = Math.abs(pb.y - pb.prevY) > WORLD_HEIGHT / 2
      pushBullet(
        pb.tempId,
        wx ? pb.x : lerp(pb.prevX, pb.x, alpha),
        wy ? pb.y : lerp(pb.prevY, pb.y, alpha),
        pb.angle,
        pb.isHoming,
        true,
      )
    }

    return this.#renderState
  }

  #integrateWithOptionalBug(
    ship: ShipState,
    input: InputCommand,
    dt: number,
  ): void {
    integrateShip(ship, input, dt, WORLD_WIDTH, WORLD_HEIGHT)
    if (this.breakDeterminism && input.thrust) {
      ship.x += (Math.random() - 0.5) * 28
      ship.y += (Math.random() - 0.5) * 28
      wrapPosition(ship, WORLD_WIDTH, WORLD_HEIGHT)
    }
  }

  #applyAuthoritativeShip(target: ShipState, s: ShipSnapshot): void {
    target.x = s.x
    target.y = s.y
    target.vx = s.vx
    target.vy = s.vy
    target.angle = s.angle
    target.hp = s.hp
    target.score = s.score
    target.alive = s.alive
    target.thrust = s.thrusting ? 520 : 0
    target.shieldTimer = s.shieldActive ? 1 : 0
    target.rapidFireTimer = s.rapidFireActive ? 1 : 0
  }

  #spawnPredictedBullet(ship: ShipState, isHoming: boolean): void {
    const cos = Math.cos(ship.angle)
    const sin = Math.sin(ship.angle)
    const speed = isHoming ? 340 : 540
    const x = ship.x + cos * (ship.radius + 6)
    const y = ship.y + sin * (ship.radius + 6)
    const pb = this.#predictedBulletPool.acquire()
    pb.tempId = `pred-${this.#nextTempBulletId++}`
    pb.x = x
    pb.y = y
    pb.prevX = x
    pb.prevY = y
    pb.vx = ship.vx + cos * speed
    pb.vy = ship.vy + sin * speed
    pb.angle = ship.angle
    pb.radius = BULLET_RADIUS
    pb.isHoming = isHoming
    pb.ttl = 0.28
    this.#predictedBullets.push(pb)
  }

  #spawnExplosion({
    x,
    y,
    big = false,
    color = '#fb923c',
  }: {
    x: number
    y: number
    big?: boolean
    color?: string
  }): void {
    const count = big ? 20 : 10
    const speed = big ? 220 : 150
    const ex = this.#explosionPool.acquire()
    ex.ttl = 0.5
    ex.maxTtl = 0.5
    ex.color = color
    ex.particles.length = 0

    for (let i = 0; i < count; i += 1) {
      const a = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4
      const spd = speed * (0.35 + Math.random() * 0.75)
      const p = this.#particlePool.acquire()
      p.x = x
      p.y = y
      p.vx = Math.cos(a) * spd
      p.vy = Math.sin(a) * spd
      p.r = 1.5 + Math.random() * 2.5
      ex.particles.push(p)
    }
    this.#explosions.push(ex)
  }

  #releaseExplosion(ex: RenderExplosion): void {
    for (let i = 0; i < ex.particles.length; i += 1) {
      const p = ex.particles[i]
      if (p) this.#particlePool.release(p)
    }
    this.#explosionPool.release(ex)
  }
}

export { asEntityId }
