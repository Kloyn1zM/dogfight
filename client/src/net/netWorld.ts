import {
  BULLET_RADIUS,
  FIRE_COOLDOWN,
  HOMING_COOLDOWN,
  RAPID_FIRE_COOLDOWN,
  TICK_DT,
  TypedBus,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  asSeq,
  asTick,
  assertNever,
  cloneShipState,
  createShipState,
  integrateShip,
  normalizeAngle,
  shortestAngleDiff,
  wrapPosition,
  type EntityId,
  type InputCommand,
  type MatchEvent,
  type PickupEffect,
  type RosterEntry,
  type ShipSnapshot,
  type ShipState,
  type Snapshot,
  type SnapshotEntity,
  type Tick,
} from '@dogfight/shared'
import type { LocalCommand } from '../input.ts'

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

export interface ExplosionParticle {
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

export interface RenderExplosion {
  ttl: number
  readonly maxTtl: number
  readonly color: string
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

interface BufferedSnapshot {
  readonly receivedAt: number
  readonly snapshot: Snapshot
  readonly byId: ReadonlyMap<EntityId, SnapshotEntity>
}

interface PredictedBullet {
  readonly tempId: string
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

  #snapshotBuffer: BufferedSnapshot[] = []
  #pendingInputs: InputCommand[] = []
  #predictedBullets: PredictedBullet[] = []
  #explosions: RenderExplosion[] = []
  #rosterByShipId = new Map<EntityId, string>()

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

  reset(): void {
    this.#snapshotBuffer.length = 0
    this.#pendingInputs.length = 0
    this.#predictedBullets.length = 0
    this.#explosions.length = 0
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
    this.#predictedBullets.length = 0
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

  resetCorrectionPeak(): void {
    this.#maxCorrectionPx = 0
  }

  stepLocal(command: LocalCommand, dt = TICK_DT): InputCommand | null {
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
      for (const p of ex.particles) {
        p.vx *= drag
        p.vy *= drag
        p.x += p.vx * dt
        p.y += p.vy * dt
      }
      ex.ttl -= dt
      if (ex.ttl <= 0) this.#explosions.splice(i, 1)
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
      if (b.ttl <= 0) this.#predictedBullets.splice(i, 1)
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
      this.#prevLocalShip = cloneShipState(this.#localShip)

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

  onSnapshot(snapshot: Snapshot, receivedAt = performance.now()): void {
    if (snapshot.tick < this.#latestServerTick) return

    this.#latestServerTick = snapshot.tick
    this.#lastSnapshotAt = receivedAt

    const byId = new Map<EntityId, SnapshotEntity>()
    for (const e of snapshot.entities) {
      byId.set(e.id, e)
    }

    this.#snapshotBuffer.push({ receivedAt, snapshot, byId })
    while (this.#snapshotBuffer.length > 24) {
      this.#snapshotBuffer.shift()
    }

    if (this.myShipId === null) return

    for (let i = this.#predictedBullets.length - 1; i >= 0; i -= 1) {
      const pb = this.#predictedBullets[i]
      if (!pb) continue
      const matched = snapshot.entities.some((e) => {
        if (e.kind !== 'bullet' || e.ownerId !== this.myShipId) return false
        const dx = wrapDelta(e.x - pb.x, WORLD_WIDTH)
        const dy = wrapDelta(e.y - pb.y, WORLD_HEIGHT)
        return dx * dx + dy * dy <= 95 * 95
      })
      if (matched) this.#predictedBullets.splice(i, 1)
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
      this.#prevLocalShip = cloneShipState(this.#localShip)
      return
    }

    if (this.predictionEnabled) {
      for (const inp of this.#pendingInputs) {
        this.#integrateWithOptionalBug(this.#localShip, inp, TICK_DT)
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

    this.#prevLocalShip = cloneShipState(this.#localShip)
  }

  onServerEvents(events: readonly MatchEvent[]): void {
    for (const evt of events) {
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
    const entities: RenderEntity[] = []

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

      entities.push({
        id: this.#localShip.id,
        kind: 'ship',
        isLocal: true,
        name: this.getPlayerName(this.#localShip.id),
        x,
        y,
        angle,
        radius: 14,
        thrusting: this.#localShip.thrust > 0,
        shieldActive: this.#localShip.shieldTimer > 0,
        rapidFireActive: this.#localShip.rapidFireTimer > 0,
        hp: this.#localShip.hp,
        score: this.#localShip.score,
      })
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

      for (const e1 of s1.snapshot.entities) {
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
            entities.push({
              kind: 'ship',
              id: e1.id,
              isLocal: e1.id === this.myShipId,
              name: this.getPlayerName(e1.id),
              x,
              y,
              angle,
              radius: 14,
              thrusting: e1.thrusting,
              shieldActive: e1.shieldActive,
              rapidFireActive: e1.rapidFireActive,
              hp: e1.hp,
              score: e1.score,
            })
            break
          case 'bullet':
            entities.push({
              kind: 'bullet',
              id: e1.id,
              x,
              y,
              angle,
              isHoming: e1.isHoming,
            })
            break
          case 'asteroid':
            entities.push({
              kind: 'asteroid',
              id: e1.id,
              x,
              y,
              angle,
              isHoming: e1.isHoming,
              radius: e1.radius,
            })
            break
          case 'pickup':
            entities.push({
              kind: 'pickup',
              id: e1.id,
              x,
              y,
              angle,
              effect: e1.effect,
              radius: e1.radius,
            })
            break
          default:
            assertNever(e1)
        }
      }
    }

    for (const pb of this.#predictedBullets) {
      const wx = Math.abs(pb.x - pb.prevX) > WORLD_WIDTH / 2
      const wy = Math.abs(pb.y - pb.prevY) > WORLD_HEIGHT / 2
      entities.push({
        id: pb.tempId,
        kind: 'bullet',
        x: wx ? pb.x : lerp(pb.prevX, pb.x, alpha),
        y: wy ? pb.y : lerp(pb.prevY, pb.y, alpha),
        angle: pb.angle,
        isHoming: pb.isHoming,
        predicted: true,
      })
    }

    return {
      entities,
      explosions: this.#explosions,
    }
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
    this.#predictedBullets.push({
      tempId: `pred-${this.#nextTempBulletId++}`,
      x,
      y,
      prevX: x,
      prevY: y,
      vx: ship.vx + cos * speed,
      vy: ship.vy + sin * speed,
      angle: ship.angle,
      radius: BULLET_RADIUS,
      isHoming,
      ttl: 0.28,
    })
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
    const particles: ExplosionParticle[] = []
    for (let i = 0; i < count; i += 1) {
      const a = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4
      const spd = speed * (0.35 + Math.random() * 0.75)
      particles.push({
        x,
        y,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd,
        r: 1.5 + Math.random() * 2.5,
      })
    }
    this.#explosions.push({
      ttl: 0.5,
      maxTtl: 0.5,
      color,
      particles,
    })
  }
}
