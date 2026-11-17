import { wrap, hideWrapForLerp, bounce } from './arena.js'
import { createHoming, getBehavior } from './behaviors.js'
import { detectCollisions } from './collision.js'
import { Asteroid, Explosion, Pickup } from './entities.js'
import { Ship } from './ship.js'

const TARGET_ASTEROIDS = 6
const MAX_PICKUPS = 2
const RESPAWN_DELAY = 2.0

/**
 * Менеджер сутностей на базі Map<id, Entity>.
 * - Ітерується через for..of завдяки [Symbol.iterator].
 * - Фільтрує без проміжних масивів через генератор *ofKind(kind).
 * - Відкладено видаляє мертві сутності наприкінці кроку (safe sweep).
 */
export class World {
  #entities = new Map()
  #pendingRemoval = new Set()

  constructor(arena, { collisionSystem = detectCollisions } = {}) {
    this.arena = arena
    this.collisionSystem = collisionSystem
    this.score = 0
    this.playerId = null
    this.respawnTimer = 0
    this.pickupTimer = 5
    this.asteroidCounter = 0
  }

  get size() {
    return this.#entities.size
  }

  spawn(entity) {
    this.#entities.set(entity.id, entity)
    return entity
  }

  despawn(id) {
    const entity = this.#entities.get(id)
    if (entity) entity.alive = false
    this.#pendingRemoval.add(id)
  }

  get(id) {
    return this.#entities.get(id)
  }

  getPlayer() {
    if (this.playerId === null) return undefined
    return this.#entities.get(this.playerId)
  }

  *[Symbol.iterator]() {
    yield* this.#entities.values()
  }

  *ofKind(kind) {
    for (const entity of this) {
      if (entity.kind === kind) yield entity
    }
  }

  reset() {
    this.#entities.clear()
    this.#pendingRemoval.clear()
    this.score = 0
    this.respawnTimer = 0
    this.pickupTimer = 5
    this.asteroidCounter = 0

    const ship = this.spawn(
      new Ship({
        x: this.arena.width / 2,
        y: this.arena.height / 2,
      }),
    )
    this.playerId = ship.id

    for (let i = 0; i < TARGET_ASTEROIDS; i += 1) {
      this.#spawnAsteroid({ homing: i === 0 })
    }
  }

  step(dt, command) {
    for (const entity of this) {
      entity.snapshotPrevious()
    }

    // Респаун корабля через 2 с у безпечній точці арени
    if (this.respawnTimer > 0) {
      this.respawnTimer = Math.max(0, this.respawnTimer - dt)
      if (this.respawnTimer === 0) {
        const spot = this.#findSafeSpawnSpot()
        const ship = this.spawn(new Ship({ x: spot.x, y: spot.y }))
        this.playerId = ship.id
      }
    }

    // Оновлення сутностей
    const player = this.getPlayer()
    if (player && player.alive && command) {
      player.integrate(command, dt)
      if (command.fire) player.fire(this, { homing: false })
      if (command.fireHoming) player.fire(this, { homing: true })
    }

    for (const entity of this) {
      if (!entity.alive) continue
      if (entity.kind !== 'ship') {
        entity.update(dt, this)
      }
      this.#applyArenaBounds(entity)
    }

    // Колізії
    for (const [a, b] of this.collisionSystem(this)) {
      if (!a.alive || !b.alive) continue
      this.#resolvePair(a, b)
    }

    // Підтримка популяції астероїдів та бонусів
    this.#maintainPopulation(dt)

    // Безпечне видалення мертвих сутностей наприкінці кроку
    this.#sweep()
  }

  #applyArenaBounds(entity) {
    if (entity.kind === 'asteroid') {
      bounce(entity, this.arena)
    } else if (entity.kind === 'ship' || entity.kind === 'bullet') {
      wrap(entity, this.arena)
      hideWrapForLerp(entity, this.arena)
    }
  }

  #resolvePair(a, b) {
    if (a.kind === 'bullet' && b.kind === 'asteroid') {
      this.#hitAsteroid(a, b)
    } else if (b.kind === 'bullet' && a.kind === 'asteroid') {
      this.#hitAsteroid(b, a)
    } else if (a.kind === 'ship' && b.kind === 'asteroid') {
      this.#hitShip(a, b)
    } else if (b.kind === 'ship' && a.kind === 'asteroid') {
      this.#hitShip(b, a)
    } else if (a.kind === 'ship' && b.kind === 'pickup') {
      this.#collectPickup(a, b)
    } else if (b.kind === 'ship' && a.kind === 'pickup') {
      this.#collectPickup(b, a)
    } else if (a.kind === 'asteroid' && b.kind === 'asteroid') {
      this.#bounceAsteroids(a, b)
    }
  }

  #hitAsteroid(bullet, asteroid) {
    this.despawn(bullet.id)
    const destroyed = asteroid.takeDamage(bullet.damage)
    if (!destroyed) return

    this.despawn(asteroid.id)
    this.score += asteroid.points
    this.spawn(
      new Explosion({
        x: asteroid.pos.x,
        y: asteroid.pos.y,
        count: asteroid.radius > 22 ? 18 : 10,
        color: asteroid.isHoming ? '#f43f5e' : '#fb923c',
      }),
    )

    // Великий астероїд розколюється на два менших
    if (asteroid.radius >= 26) {
      for (let i = 0; i < 2; i += 1) {
        const angle = Math.random() * Math.PI * 2
        const speed = 110 + Math.random() * 60
        this.spawn(
          new Asteroid({
            x: asteroid.pos.x + Math.cos(angle) * 12,
            y: asteroid.pos.y + Math.sin(angle) * 12,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            radius: 16,
            hp: 25,
            spin: (Math.random() - 0.5) * 3,
            points: 50,
          }),
        )
      }
    } else if (Math.random() < 0.35) {
      this.#spawnPickupAt(asteroid.pos.x, asteroid.pos.y)
    }
  }

  #hitShip(ship, asteroid) {
    const damaged = ship.takeDamage(35)
    this.#bounceAsteroids(ship, asteroid)

    if (!damaged) return

    this.spawn(
      new Explosion({
        x: ship.pos.x,
        y: ship.pos.y,
        count: ship.alive ? 8 : 26,
        color: ship.alive ? '#facc15' : '#ef4444',
        speed: ship.alive ? 130 : 250,
      }),
    )

    if (!ship.alive) {
      this.despawn(ship.id)
      this.playerId = null
      this.respawnTimer = RESPAWN_DELAY
    }
  }

  #collectPickup(ship, pickup) {
    const comp = getBehavior(pickup, 'pickup')
    if (comp) {
      ship.applyPickup(comp.effect, comp.duration)
    }
    this.despawn(pickup.id)
  }

  #bounceAsteroids(a, b) {
    const dx = b.pos.x - a.pos.x
    const dy = b.pos.y - a.pos.y
    const dist = Math.hypot(dx, dy)
    const nx = dist > 0.0001 ? dx / dist : 1
    const ny = dist > 0.0001 ? dy / dist : 0
    const overlap = a.radius + b.radius - dist

    if (overlap > 0) {
      a.pos.x -= nx * (overlap / 2)
      a.pos.y -= ny * (overlap / 2)
      b.pos.x += nx * (overlap / 2)
      b.pos.y += ny * (overlap / 2)
    }

    const rvx = b.vel.x - a.vel.x
    const rvy = b.vel.y - a.vel.y
    const velAlongNormal = rvx * nx + rvy * ny
    if (velAlongNormal > 0) return

    const impulse = -velAlongNormal
    a.vel.x -= impulse * nx
    a.vel.y -= impulse * ny
    b.vel.x += impulse * nx
    b.vel.y += impulse * ny
  }

  #maintainPopulation(dt) {
    let asteroidCount = 0
    for (const a of this.ofKind('asteroid')) {
      if (a.alive) asteroidCount += 1
    }
    if (asteroidCount < TARGET_ASTEROIDS) {
      this.asteroidCounter += 1
      this.#spawnAsteroid({ homing: this.asteroidCounter % 4 === 0 })
    }

    this.pickupTimer -= dt
    if (this.pickupTimer <= 0) {
      this.pickupTimer = 8
      let pickupCount = 0
      for (const p of this.ofKind('pickup')) {
        if (p.alive) pickupCount += 1
      }
      if (pickupCount < MAX_PICKUPS) {
        const margin = 60
        const x = margin + Math.random() * Math.max(10, this.arena.width - margin * 2)
        const y = margin + Math.random() * Math.max(10, this.arena.height - margin * 2)
        this.#spawnPickupAt(x, y)
      }
    }
  }

  #spawnAsteroid({ homing = false } = {}) {
    const w = Math.max(this.arena.width, 300)
    const h = Math.max(this.arena.height, 300)
    const edge = Math.floor(Math.random() * 4)
    let x
    let y

    if (edge === 0) {
      x = Math.random() * w
      y = 36
    } else if (edge === 1) {
      x = w - 36
      y = Math.random() * h
    } else if (edge === 2) {
      x = Math.random() * w
      y = h - 36
    } else {
      x = 36
      y = Math.random() * h
    }

    const angle = Math.random() * Math.PI * 2
    const speed = homing ? 95 : 70 + Math.random() * 65
    const behaviors = homing
      ? [createHoming({ targetKind: 'ship', turnRate: 1.4, speed: 115 })]
      : []

    this.spawn(
      new Asteroid({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: homing ? 22 : 28,
        hp: 50,
        spin: (Math.random() - 0.5) * 2.2,
        points: homing ? 150 : 100,
        behaviors,
      }),
    )
  }

  #spawnPickupAt(x, y) {
    const effect = Math.random() < 0.5 ? 'shield' : 'rapidFire'
    this.spawn(new Pickup({ x, y, effect, duration: 6 }))
  }

  #findSafeSpawnSpot() {
    let best = { x: this.arena.width / 2, y: this.arena.height / 2 }
    let bestMinDist = -1

    for (let i = 0; i < 12; i += 1) {
      const cx = 60 + Math.random() * Math.max(10, this.arena.width - 120)
      const cy = 60 + Math.random() * Math.max(10, this.arena.height - 120)
      let minDist = Infinity
      for (const a of this.ofKind('asteroid')) {
        const d = Math.hypot(a.pos.x - cx, a.pos.y - cy)
        if (d < minDist) minDist = d
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist
        best = { x: cx, y: cy }
      }
    }
    return best
  }

  #sweep() {
    for (const [id, entity] of this.#entities) {
      if (!entity.alive) this.#pendingRemoval.add(id)
    }
    for (const id of this.#pendingRemoval) {
      this.#entities.delete(id)
    }
    this.#pendingRemoval.clear()
  }
}