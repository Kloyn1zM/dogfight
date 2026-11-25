import { ObjectPool } from '../pool.ts'
import { createPrng, type Prng } from '../prng.ts'
import {
  asEntityId,
  asSeq,
  asTick,
  type EntityId,
  type InputCommand,
  type MatchEvent,
  type PickupEffect,
  type Seq,
  type Snapshot,
  type SnapshotEntity,
  type Tick,
} from '../types.ts'
import {
  BULLET_RADIUS,
  FIRE_COOLDOWN,
  HOMING_COOLDOWN,
  PICKUP_RADIUS,
  RAPID_FIRE_COOLDOWN,
  RESPAWN_DELAY,
  SHIP_MAX_HP,
  SHIP_RADIUS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from './constants.ts'
import {
  bouncePosition,
  createShipState,
  integrateShip,
  normalizeAngle,
  shortestAngleDiff,
  wrapPosition,
  type MovingBounded,
  type ShipState,
} from './physics.ts'
import { SpatialHashGrid } from './spatialHash.ts'

const MAX_PICKUPS = 2
const MAX_ASTEROID_RADIUS = 28
const SPATIAL_CELL_SIZE = 64

export type CollisionMode = 'spatial' | 'naive'

interface BulletInternal {
  id: EntityId
  kind: 'bullet'
  ownerId: EntityId
  x: number
  y: number
  vx: number
  vy: number
  angle: number
  radius: number
  ttl: number
  damage: number
  isHoming: boolean
}

interface AsteroidInternal extends MovingBounded {
  id: EntityId
  kind: 'asteroid'
  angle: number
  hp: number
  spin: number
  points: number
  isHoming: boolean
}

interface PickupInternal {
  id: EntityId
  kind: 'pickup'
  x: number
  y: number
  angle: number
  radius: number
  effect: PickupEffect
  ttl: number
}

export interface MatchWorldOptions {
  seed?: number
  width?: number
  height?: number
  targetAsteroids?: number
  homingEvery?: number
  collisionMode?: CollisionMode
}

export interface WorldPoolStats {
  readonly bulletsCreated: number
  readonly bulletsReused: number
  readonly bulletsAvailable: number
}

const IDLE_INPUT: Pick<
  InputCommand,
  'turn' | 'thrust' | 'fire' | 'fireHoming'
> = {
  turn: 0,
  thrust: false,
  fire: false,
  fireHoming: false,
}

export class MatchWorld {
  #prng: Prng
  #nextEntityId = 100
  #ships = new Map<EntityId, ShipState>()
  #bullets = new Map<EntityId, BulletInternal>()
  #asteroids = new Map<EntityId, AsteroidInternal>()
  #pickups = new Map<EntityId, PickupInternal>()

  #bulletPool = new ObjectPool<BulletInternal>(
    () => ({
      id: asEntityId(0),
      kind: 'bullet',
      ownerId: asEntityId(0),
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      angle: 0,
      radius: BULLET_RADIUS,
      ttl: 0,
      damage: 25,
      isHoming: false,
    }),
    { initialSize: 64, maxSize: 1024 },
  )

  #shipGrid: SpatialHashGrid<ShipState>
  #asteroidGrid: SpatialHashGrid<AsteroidInternal>
  #pickupGrid: SpatialHashGrid<PickupInternal>
  #bulletScratch: BulletInternal[] = []
  #asteroidScratch: AsteroidInternal[] = []
  #shipQuery: ShipState[] = []
  #asteroidQuery: AsteroidInternal[] = []
  #pickupQuery: PickupInternal[] = []
  #asteroidIndex = new Int32Array(65536)

  readonly width: number
  readonly height: number
  readonly targetAsteroids: number
  readonly homingEvery: number
  readonly collisionMode: CollisionMode

  tick = 0
  elapsedMs = 0
  pickupTimer = 6
  asteroidCounter = 0

  constructor({
    seed = 1337,
    width = WORLD_WIDTH,
    height = WORLD_HEIGHT,
    targetAsteroids = 6,
    homingEvery = 4,
    collisionMode = 'spatial',
  }: MatchWorldOptions = {}) {
    this.width = width
    this.height = height
    this.targetAsteroids = targetAsteroids
    this.homingEvery = homingEvery
    this.collisionMode = collisionMode
    this.#prng = createPrng(seed)
    this.#shipGrid = new SpatialHashGrid<ShipState>(
      width,
      height,
      SPATIAL_CELL_SIZE,
    )
    this.#asteroidGrid = new SpatialHashGrid<AsteroidInternal>(
      width,
      height,
      SPATIAL_CELL_SIZE,
    )
    this.#pickupGrid = new SpatialHashGrid<PickupInternal>(
      width,
      height,
      SPATIAL_CELL_SIZE,
    )

    for (let i = 0; i < this.targetAsteroids; i += 1) {
      this.#spawnAsteroid({ homing: i === 0 })
    }
  }

  get currentTick(): Tick {
    return asTick(this.tick)
  }

  getPoolStats(): WorldPoolStats {
    return {
      bulletsCreated: this.#bulletPool.created,
      bulletsReused: this.#bulletPool.reused,
      bulletsAvailable: this.#bulletPool.available,
    }
  }

  #allocId(): EntityId {
    const id = this.#nextEntityId
    this.#nextEntityId =
      this.#nextEntityId >= 60000 ? 100 : this.#nextEntityId + 1
    return asEntityId(id)
  }

  addShip(shipId: EntityId): ShipState {
    const spot = this.#findSafeSpawnSpot()
    const ship = createShipState({
      id: shipId,
      x: spot.x,
      y: spot.y,
      angle: -Math.PI / 2,
    })
    this.#ships.set(shipId, ship)
    return ship
  }

  removeShip(shipId: EntityId): void {
    this.#ships.delete(shipId)
  }

  getShip(shipId: EntityId): ShipState | undefined {
    return this.#ships.get(shipId)
  }

  step(
    dt: number,
    inputsByShipId?: ReadonlyMap<
      EntityId,
      Pick<InputCommand, 'turn' | 'thrust' | 'fire' | 'fireHoming'>
    >,
  ): MatchEvent[] {
    const events: MatchEvent[] = []
    this.tick += 1
    this.elapsedMs = Math.round(this.elapsedMs + dt * 1000)

    for (const ship of this.#ships.values()) {
      if (!ship.alive) {
        ship.respawnTimer = Math.max(0, ship.respawnTimer - dt)
        if (ship.respawnTimer === 0) {
          const spot = this.#findSafeSpawnSpot()
          ship.x = spot.x
          ship.y = spot.y
          ship.vx = 0
          ship.vy = 0
          ship.angle = -Math.PI / 2
          ship.hp = SHIP_MAX_HP
          ship.alive = true
          ship.thrust = 0
          ship.shieldTimer = 2.0
          ship.rapidFireTimer = 0
          ship.fireCooldown = 0
          ship.homingCooldown = 0
        }
        continue
      }

      const input = inputsByShipId?.get(ship.id) ?? IDLE_INPUT
      integrateShip(ship, input, dt, this.width, this.height)

      if (input.fire) {
        const b = this.#tryFire(ship, false)
        if (b) events.push({ type: 'fired', ownerId: ship.id, homing: false })
      }
      if (input.fireHoming) {
        const b = this.#tryFire(ship, true)
        if (b) events.push({ type: 'fired', ownerId: ship.id, homing: true })
      }
    }

    for (const [id, bullet] of this.#bullets) {
      if (bullet.isHoming) {
        this.#steerHomingBullet(bullet, dt)
      }
      bullet.x += bullet.vx * dt
      bullet.y += bullet.vy * dt
      wrapPosition(bullet, this.width, this.height)
      bullet.ttl -= dt
      if (bullet.ttl <= 0) {
        this.#bullets.delete(id)
        this.#bulletPool.release(bullet)
      }
    }

    for (const asteroid of this.#asteroids.values()) {
      if (asteroid.isHoming) {
        this.#steerHomingAsteroid(asteroid, dt)
      }
      asteroid.x += asteroid.vx * dt
      asteroid.y += asteroid.vy * dt
      asteroid.angle = normalizeAngle(asteroid.angle + asteroid.spin * dt)
      bouncePosition(asteroid, this.width, this.height)
    }

    for (const [id, pickup] of this.#pickups) {
      pickup.angle = normalizeAngle(pickup.angle + 1.8 * dt)
      pickup.ttl -= dt
      if (pickup.ttl <= 0) this.#pickups.delete(id)
    }

    this.#resolveCollisions(events)
    this.#maintainPopulation(dt)

    return events
  }

  getSnapshot(lastProcessedSeq: Seq = asSeq(0)): Snapshot {
    const entities: SnapshotEntity[] = []

    for (const s of this.#ships.values()) {
      entities.push({
        id: s.id,
        kind: 'ship',
        x: s.x,
        y: s.y,
        vx: s.vx,
        vy: s.vy,
        angle: s.angle,
        thrusting: s.thrust > 0,
        shieldActive: s.shieldTimer > 0,
        rapidFireActive: s.rapidFireTimer > 0,
        alive: s.alive,
        hp: s.hp,
        score: s.score,
      })
    }

    for (const b of this.#bullets.values()) {
      entities.push({
        id: b.id,
        kind: 'bullet',
        x: b.x,
        y: b.y,
        vx: b.vx,
        vy: b.vy,
        angle: b.angle,
        isHoming: b.isHoming,
        ownerId: b.ownerId,
      })
    }

    for (const a of this.#asteroids.values()) {
      entities.push({
        id: a.id,
        kind: 'asteroid',
        x: a.x,
        y: a.y,
        vx: a.vx,
        vy: a.vy,
        angle: a.angle,
        isHoming: a.isHoming,
        radius: a.radius,
        hp: a.hp,
      })
    }

    for (const p of this.#pickups.values()) {
      entities.push({
        id: p.id,
        kind: 'pickup',
        x: p.x,
        y: p.y,
        vx: 0,
        vy: 0,
        angle: p.angle,
        effect: p.effect,
        radius: p.radius,
      })
    }

    return {
      tick: asTick(this.tick),
      lastProcessedSeq,
      matchTimeMs: this.elapsedMs,
      entities,
    }
  }

  #tryFire(ship: ShipState, homing: boolean): BulletInternal | null {
    if (homing) {
      if (ship.homingCooldown > 0) return null
      ship.homingCooldown = HOMING_COOLDOWN
    } else {
      if (ship.fireCooldown > 0) return null
      ship.fireCooldown =
        ship.rapidFireTimer > 0 ? RAPID_FIRE_COOLDOWN : FIRE_COOLDOWN
    }

    const cos = Math.cos(ship.angle)
    const sin = Math.sin(ship.angle)
    const bulletSpeed = homing ? 340 : 540
    const id = this.#allocId()

    const bullet = this.#bulletPool.acquire()
    bullet.id = id
    bullet.ownerId = ship.id
    bullet.x = ship.x + cos * (ship.radius + 6)
    bullet.y = ship.y + sin * (ship.radius + 6)
    bullet.vx = ship.vx + cos * bulletSpeed
    bullet.vy = ship.vy + sin * bulletSpeed
    bullet.angle = ship.angle
    bullet.radius = BULLET_RADIUS
    bullet.ttl = homing ? 2.5 : 1.4
    bullet.damage = homing ? 45 : 25
    bullet.isHoming = homing

    wrapPosition(bullet, this.width, this.height)
    this.#bullets.set(id, bullet)
    return bullet
  }

  #steerHomingBullet(bullet: BulletInternal, dt: number): void {
    let target: { x: number; y: number } | null = null
    let bestDistSq = Infinity

    for (const ship of this.#ships.values()) {
      if (!ship.alive || ship.id === bullet.ownerId) continue
      const dx = ship.x - bullet.x
      const dy = ship.y - bullet.y
      const dSq = dx * dx + dy * dy
      if (dSq < bestDistSq) {
        bestDistSq = dSq
        target = ship
      }
    }

    for (const a of this.#asteroids.values()) {
      const dx = a.x - bullet.x
      const dy = a.y - bullet.y
      const dSq = dx * dx + dy * dy
      if (dSq < bestDistSq) {
        bestDistSq = dSq
        target = a
      }
    }

    if (!target) return
    const desired = Math.atan2(target.y - bullet.y, target.x - bullet.x)
    const current = Math.atan2(bullet.vy, bullet.vx)
    const diff = shortestAngleDiff(current, desired)
    const maxTurn = 4.5 * dt
    const next = normalizeAngle(
      current + Math.max(-maxTurn, Math.min(maxTurn, diff)),
    )
    bullet.angle = next
    bullet.vx = Math.cos(next) * 380
    bullet.vy = Math.sin(next) * 380
  }

  #steerHomingAsteroid(asteroid: AsteroidInternal, dt: number): void {
    let target: ShipState | null = null
    let bestDistSq = Infinity

    for (const ship of this.#ships.values()) {
      if (!ship.alive) continue
      const dx = ship.x - asteroid.x
      const dy = ship.y - asteroid.y
      const dSq = dx * dx + dy * dy
      if (dSq < bestDistSq) {
        bestDistSq = dSq
        target = ship
      }
    }

    if (!target) return
    const desired = Math.atan2(target.y - asteroid.y, target.x - asteroid.x)
    const current = Math.atan2(asteroid.vy, asteroid.vx)
    const diff = shortestAngleDiff(current, desired)
    const maxTurn = 1.4 * dt
    const next = current + Math.max(-maxTurn, Math.min(maxTurn, diff))
    asteroid.vx = Math.cos(next) * 115
    asteroid.vy = Math.sin(next) * 115
  }

  #resolveCollisions(events: MatchEvent[]): void {
    if (this.collisionMode === 'naive') {
      this.#resolveCollisionsNaive(events)
    } else {
      this.#resolveCollisionsSpatial(events)
    }
  }

  #resolveCollisionsSpatial(events: MatchEvent[]): void {
    this.#shipGrid.clear()
    for (const ship of this.#ships.values()) {
      if (ship.alive) this.#shipGrid.insert(ship)
    }

    this.#asteroidGrid.clear()
    for (const asteroid of this.#asteroids.values()) {
      this.#asteroidGrid.insert(asteroid)
    }

    this.#bulletScratch.length = 0
    for (const bullet of this.#bullets.values()) {
      this.#bulletScratch.push(bullet)
    }

    for (let i = 0; i < this.#bulletScratch.length; i += 1) {
      const bullet = this.#bulletScratch[i]
      if (!bullet) continue
      let consumed = false

      this.#shipGrid.queryCircle(
        bullet.x,
        bullet.y,
        bullet.radius + SHIP_RADIUS,
        this.#shipQuery,
      )
      for (let j = 0; j < this.#shipQuery.length; j += 1) {
        const ship = this.#shipQuery[j]
        if (!ship || !ship.alive || ship.id === bullet.ownerId) continue
        const dx = ship.x - bullet.x
        const dy = ship.y - bullet.y
        const r = ship.radius + bullet.radius
        if (dx * dx + dy * dy <= r * r) {
          this.#bullets.delete(bullet.id)
          this.#bulletPool.release(bullet)
          consumed = true
          this.#damageShip(ship, bullet.damage, bullet.ownerId, events)
          break
        }
      }
      if (consumed) continue

      this.#asteroidGrid.queryCircle(
        bullet.x,
        bullet.y,
        bullet.radius + MAX_ASTEROID_RADIUS,
        this.#asteroidQuery,
      )
      for (let j = 0; j < this.#asteroidQuery.length; j += 1) {
        const asteroid = this.#asteroidQuery[j]
        if (!asteroid || !this.#asteroids.has(asteroid.id)) continue
        const dx = asteroid.x - bullet.x
        const dy = asteroid.y - bullet.y
        const r = asteroid.radius + bullet.radius
        if (dx * dx + dy * dy <= r * r) {
          this.#bullets.delete(bullet.id)
          this.#bulletPool.release(bullet)
          asteroid.hp -= bullet.damage
          events.push({ type: 'hit', x: asteroid.x, y: asteroid.y })
          if (asteroid.hp <= 0) {
            this.#asteroids.delete(asteroid.id)
            const owner = this.#ships.get(bullet.ownerId)
            if (owner) {
              owner.score = Math.min(65535, owner.score + asteroid.points)
            }
            events.push({
              type: 'exploded',
              kind: 'asteroid',
              big: asteroid.radius >= 26,
              x: asteroid.x,
              y: asteroid.y,
            })
            this.#splitOrDrop(asteroid, true)
          }
          break
        }
      }
    }

    this.#asteroidGrid.clear()
    for (const asteroid of this.#asteroids.values()) {
      this.#asteroidGrid.insert(asteroid)
    }

    this.#pickupGrid.clear()
    for (const pickup of this.#pickups.values()) {
      this.#pickupGrid.insert(pickup)
    }

    for (const ship of this.#ships.values()) {
      if (!ship.alive) continue

      this.#asteroidGrid.queryCircle(
        ship.x,
        ship.y,
        ship.radius + MAX_ASTEROID_RADIUS,
        this.#asteroidQuery,
      )
      for (let j = 0; j < this.#asteroidQuery.length; j += 1) {
        const asteroid = this.#asteroidQuery[j]
        if (!asteroid) continue
        const dx = asteroid.x - ship.x
        const dy = asteroid.y - ship.y
        const r = ship.radius + asteroid.radius
        if (dx * dx + dy * dy <= r * r) {
          this.#bouncePair(ship, asteroid)
          this.#damageShip(ship, 35, null, events)
        }
      }

      this.#pickupGrid.queryCircle(
        ship.x,
        ship.y,
        ship.radius + PICKUP_RADIUS,
        this.#pickupQuery,
      )
      for (let j = 0; j < this.#pickupQuery.length; j += 1) {
        const pickup = this.#pickupQuery[j]
        if (!pickup || !this.#pickups.has(pickup.id)) continue
        const dx = pickup.x - ship.x
        const dy = pickup.y - ship.y
        const r = ship.radius + pickup.radius
        if (dx * dx + dy * dy <= r * r) {
          this.#pickups.delete(pickup.id)
          if (pickup.effect === 'shield') ship.shieldTimer = 6
          else ship.rapidFireTimer = 6
          events.push({
            type: 'pickup',
            shipId: ship.id,
            effect: pickup.effect,
          })
        }
      }
    }

    this.#asteroidScratch.length = 0
    this.#asteroidGrid.clear()
    let idx = 0
    for (const asteroid of this.#asteroids.values()) {
      this.#asteroidScratch.push(asteroid)
      this.#asteroidIndex[asteroid.id & 0xffff] = idx
      idx += 1
      this.#asteroidGrid.insert(asteroid)
    }

    for (let i = 0; i < this.#asteroidScratch.length; i += 1) {
      const a = this.#asteroidScratch[i]
      if (!a) continue
      this.#asteroidGrid.queryCircle(
        a.x,
        a.y,
        a.radius + MAX_ASTEROID_RADIUS + 4,
        this.#asteroidQuery,
      )
      for (let k = 0; k < this.#asteroidQuery.length; k += 1) {
        const b = this.#asteroidQuery[k]
        if (!b) continue
        const j = this.#asteroidIndex[b.id & 0xffff] ?? -1
        if (j <= i) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const r = a.radius + b.radius
        if (dx * dx + dy * dy <= r * r) {
          this.#bouncePair(a, b)
        }
      }
    }
  }

  #resolveCollisionsNaive(events: MatchEvent[]): void {
    this.#bulletScratch.length = 0
    for (const bullet of this.#bullets.values()) {
      this.#bulletScratch.push(bullet)
    }

    for (let bi = 0; bi < this.#bulletScratch.length; bi += 1) {
      const bullet = this.#bulletScratch[bi]
      if (!bullet) continue
      let consumed = false

      for (const ship of this.#ships.values()) {
        if (!ship.alive || ship.id === bullet.ownerId) continue
        const dx = ship.x - bullet.x
        const dy = ship.y - bullet.y
        const r = ship.radius + bullet.radius
        if (dx * dx + dy * dy <= r * r) {
          this.#bullets.delete(bullet.id)
          this.#bulletPool.release(bullet)
          consumed = true
          this.#damageShip(ship, bullet.damage, bullet.ownerId, events)
          break
        }
      }
      if (consumed) continue

      this.#asteroidScratch.length = 0
      for (const asteroid of this.#asteroids.values()) {
        this.#asteroidScratch.push(asteroid)
      }
      for (let ai = 0; ai < this.#asteroidScratch.length; ai += 1) {
        const asteroid = this.#asteroidScratch[ai]
        if (!asteroid) continue
        const dx = asteroid.x - bullet.x
        const dy = asteroid.y - bullet.y
        const r = asteroid.radius + bullet.radius
        if (dx * dx + dy * dy <= r * r) {
          this.#bullets.delete(bullet.id)
          this.#bulletPool.release(bullet)
          asteroid.hp -= bullet.damage
          events.push({ type: 'hit', x: asteroid.x, y: asteroid.y })
          if (asteroid.hp <= 0) {
            this.#asteroids.delete(asteroid.id)
            const owner = this.#ships.get(bullet.ownerId)
            if (owner) {
              owner.score = Math.min(65535, owner.score + asteroid.points)
            }
            events.push({
              type: 'exploded',
              kind: 'asteroid',
              big: asteroid.radius >= 26,
              x: asteroid.x,
              y: asteroid.y,
            })
            this.#splitOrDrop(asteroid, false)
          }
          break
        }
      }
    }

    for (const ship of this.#ships.values()) {
      if (!ship.alive) continue

      for (const asteroid of this.#asteroids.values()) {
        const dx = asteroid.x - ship.x
        const dy = asteroid.y - ship.y
        const r = ship.radius + asteroid.radius
        if (dx * dx + dy * dy <= r * r) {
          this.#bouncePair(ship, asteroid)
          this.#damageShip(ship, 35, null, events)
        }
      }

      for (const [pId, pickup] of this.#pickups) {
        const dx = pickup.x - ship.x
        const dy = pickup.y - ship.y
        const r = ship.radius + pickup.radius
        if (dx * dx + dy * dy <= r * r) {
          this.#pickups.delete(pId)
          if (pickup.effect === 'shield') ship.shieldTimer = 6
          else ship.rapidFireTimer = 6
          events.push({
            type: 'pickup',
            shipId: ship.id,
            effect: pickup.effect,
          })
        }
      }
    }

    this.#asteroidScratch.length = 0
    for (const asteroid of this.#asteroids.values()) {
      this.#asteroidScratch.push(asteroid)
    }
    for (let i = 0; i < this.#asteroidScratch.length; i += 1) {
      const a = this.#asteroidScratch[i]
      if (!a) continue
      for (let j = i + 1; j < this.#asteroidScratch.length; j += 1) {
        const b = this.#asteroidScratch[j]
        if (!b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const r = a.radius + b.radius
        if (dx * dx + dy * dy <= r * r) {
          this.#bouncePair(a, b)
        }
      }
    }
  }

  #damageShip(
    ship: ShipState,
    amount: number,
    attackerId: EntityId | null,
    events: MatchEvent[],
  ): void {
    if (!ship.alive || ship.shieldTimer > 0) return
    ship.hp = Math.max(0, ship.hp - amount)
    events.push({ type: 'hit', x: ship.x, y: ship.y })

    if (ship.hp === 0) {
      ship.alive = false
      ship.thrust = 0
      ship.respawnTimer = RESPAWN_DELAY
      if (attackerId !== null) {
        const attacker = this.#ships.get(attackerId)
        if (attacker) attacker.score = Math.min(65535, attacker.score + 250)
      }
      events.push({
        type: 'exploded',
        kind: 'ship',
        big: true,
        x: ship.x,
        y: ship.y,
      })
    }
  }

  #splitOrDrop(asteroid: AsteroidInternal, insertIntoGrid: boolean): void {
    if (asteroid.radius >= 26) {
      for (let i = 0; i < 2; i += 1) {
        const angle = this.#prng.next() * Math.PI * 2
        const speed = 110 + this.#prng.next() * 60
        const id = this.#allocId()
        const child: AsteroidInternal = {
          id,
          kind: 'asteroid',
          x: asteroid.x + Math.cos(angle) * 12,
          y: asteroid.y + Math.sin(angle) * 12,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          angle: 0,
          radius: 16,
          hp: 25,
          spin: (this.#prng.next() - 0.5) * 3,
          points: 50,
          isHoming: false,
        }
        this.#asteroids.set(id, child)
        if (insertIntoGrid) this.#asteroidGrid.insert(child)
      }
    } else if (this.#prng.next() < 0.35 && this.#pickups.size < MAX_PICKUPS) {
      this.#spawnPickupAt(asteroid.x, asteroid.y)
    }
  }

  #bouncePair(a: MovingBounded, b: MovingBounded): void {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.hypot(dx, dy)
    const nx = dist > 0.0001 ? dx / dist : 1
    const ny = dist > 0.0001 ? dy / dist : 0
    const overlap = a.radius + b.radius - dist

    if (overlap > 0) {
      a.x -= nx * (overlap / 2)
      a.y -= ny * (overlap / 2)
      b.x += nx * (overlap / 2)
      b.y += ny * (overlap / 2)
    }

    const velAlongNormal = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny
    if (velAlongNormal > 0) return

    const impulse = -velAlongNormal
    a.vx -= impulse * nx
    a.vy -= impulse * ny
    b.vx += impulse * nx
    b.vy += impulse * ny
  }

  #maintainPopulation(dt: number): void {
    if (this.#asteroids.size < this.targetAsteroids) {
      this.asteroidCounter += 1
      this.#spawnAsteroid({
        homing: this.asteroidCounter % this.homingEvery === 0,
      })
    }

    this.pickupTimer -= dt
    if (this.pickupTimer <= 0) {
      this.pickupTimer = 8
      if (this.#pickups.size < MAX_PICKUPS) {
        const margin = 60
        const x = margin + this.#prng.next() * (this.width - margin * 2)
        const y = margin + this.#prng.next() * (this.height - margin * 2)
        this.#spawnPickupAt(x, y)
      }
    }
  }

  #spawnAsteroid({ homing = false }: { homing?: boolean } = {}): void {
    const edge = Math.floor(this.#prng.next() * 4)
    let x: number
    let y: number

    if (edge === 0) {
      x = this.#prng.next() * this.width
      y = 36
    } else if (edge === 1) {
      x = this.width - 36
      y = this.#prng.next() * this.height
    } else if (edge === 2) {
      x = this.#prng.next() * this.width
      y = this.height - 36
    } else {
      x = 36
      y = this.#prng.next() * this.height
    }

    const angle = this.#prng.next() * Math.PI * 2
    const speed = homing ? 95 : 70 + this.#prng.next() * 65
    const id = this.#allocId()

    this.#asteroids.set(id, {
      id,
      kind: 'asteroid',
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      angle: 0,
      radius: homing ? 22 : 28,
      hp: 50,
      spin: (this.#prng.next() - 0.5) * 2.2,
      points: homing ? 150 : 100,
      isHoming: homing,
    })
  }

  #spawnPickupAt(x: number, y: number): void {
    const id = this.#allocId()
    const effect: PickupEffect =
      this.#prng.next() < 0.5 ? 'shield' : 'rapidFire'
    this.#pickups.set(id, {
      id,
      kind: 'pickup',
      x,
      y,
      angle: 0,
      radius: PICKUP_RADIUS,
      effect,
      ttl: 12,
    })
  }

  #findSafeSpawnSpot(): { x: number; y: number } {
    let bestX = this.width / 2
    let bestY = this.height / 2
    let bestMinDist = -1

    for (let i = 0; i < 12; i += 1) {
      const cx = 80 + this.#prng.next() * (this.width - 160)
      const cy = 80 + this.#prng.next() * (this.height - 160)
      let minDist = Infinity
      for (const a of this.#asteroids.values()) {
        const d = Math.hypot(a.x - cx, a.y - cy)
        if (d < minDist) minDist = d
      }
      for (const s of this.#ships.values()) {
        if (!s.alive) continue
        const d = Math.hypot(s.x - cx, s.y - cy)
        if (d < minDist) minDist = d
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist
        bestX = cx
        bestY = cy
      }
    }
    return { x: bestX, y: bestY }
  }
}
