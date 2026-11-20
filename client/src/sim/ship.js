import { Entity } from './entity.js'
import { Vector2 } from './vector.js'
import { createHoming } from './behaviors.js'
import { Bullet } from './entities.js'

export const ROTATE_SPEED = 3.6
export const THRUST = 520
export const DRAG = 1.15
export const MAX_SPEED = 380

/**
 * Корабель гравця: рівно один рівень успадкування (Ship extends Entity).
 * Здоров'я (#hp) та кулдауни інкапсульовані приватними полями класу.
 */
export class Ship extends Entity {
  #hp
  #maxHp
  #fireCooldown = 0
  #homingCooldown = 0
  #shieldTimer = 0
  #rapidFireTimer = 0

  constructor({ x = 0, y = 0, angle = -Math.PI / 2, maxHp = 100 } = {}) {
    super({ kind: 'ship', x, y, angle, radius: 14 })
    this.#maxHp = maxHp
    this.#hp = maxHp
    this.thrust = 0
  }

  get hp() {
    return this.#hp
  }

  get maxHp() {
    return this.#maxHp
  }

  get shieldTimer() {
    return this.#shieldTimer
  }

  get rapidFireTimer() {
    return this.#rapidFireTimer
  }

  get shieldActive() {
    return this.#shieldTimer > 0
  }

  get rapidFireActive() {
    return this.#rapidFireTimer > 0
  }

  takeDamage(amount) {
    if (!this.alive) return false
    if (this.#shieldTimer > 0) return false
    this.#hp = Math.max(0, this.#hp - amount)
    if (this.#hp === 0) this.alive = false
    return true
  }

  applyPickup(effect, duration) {
    if (effect === 'shield') {
      this.#shieldTimer = duration
    } else if (effect === 'rapidFire') {
      this.#rapidFireTimer = duration
    }
  }

  integrate(command, dt) {
    if (!this.alive) return

    this.#fireCooldown = Math.max(0, this.#fireCooldown - dt)
    this.#homingCooldown = Math.max(0, this.#homingCooldown - dt)
    this.#shieldTimer = Math.max(0, this.#shieldTimer - dt)
    this.#rapidFireTimer = Math.max(0, this.#rapidFireTimer - dt)

    const turn = Math.max(-1, Math.min(1, command.turn || 0))
    const thrusting = Boolean(command.thrust)

    this.angle += turn * ROTATE_SPEED * dt
    this.thrust = thrusting ? THRUST : 0

    if (thrusting) {
      this.vel.x += Math.cos(this.angle) * THRUST * dt
      this.vel.y += Math.sin(this.angle) * THRUST * dt
    }

    const damp = Math.exp(-DRAG * dt)
    this.vel.x *= damp
    this.vel.y *= damp

    const speed = this.vel.length()
    if (speed > MAX_SPEED) {
      const scale = MAX_SPEED / speed
      this.vel.x *= scale
      this.vel.y *= scale
    }

    this.pos.x += this.vel.x * dt
    this.pos.y += this.vel.y * dt
  }

  /**
   * Метод прототипу: очікує `this === ship`.
   * Передача `ship.fire` напряму в addEventListener ламає `this` (класичний баг Lab 2).
   */
  fire(world, { homing = false } = {}) {
    if (!this.alive) return null

    if (homing) {
      if (this.#homingCooldown > 0) return null
      this.#homingCooldown = 0.85
    } else {
      if (this.#fireCooldown > 0) return null
      this.#fireCooldown = this.#rapidFireTimer > 0 ? 0.09 : 0.22
    }

    const dir = Vector2.fromAngle(this.angle)
    const nose = this.pos.add(dir.scale(this.radius + 6))
    const bulletSpeed = homing ? 340 : 540
    const vel = this.vel.add(dir.scale(bulletSpeed))

    const behaviors = homing
      ? [
          createHoming({
            targetKind: 'asteroid',
            ignoreId: this.id,
            turnRate: 4.5,
            speed: 380,
          }),
        ]
      : []

    const bullet = new Bullet({
      x: nose.x,
      y: nose.y,
      vx: vel.x,
      vy: vel.y,
      angle: this.angle,
      ownerId: this.id,
      ttl: homing ? 2.6 : 1.4,
      damage: homing ? 50 : 25,
      behaviors,
    })

    const spawned = world.spawn(bullet)
    world.emit('fired', { homing, ownerId: this.id })
    return spawned
  }
}
