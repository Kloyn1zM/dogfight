import { Vector2 } from './vector.js'

/**
 * Базова сутність ігрового світу.
 * Правило курсу: успадкування не глибше одного рівня (Ship/Bullet/Asteroid/Pickup/Explosion extends Entity).
 * Усі додаткові здібності (наприклад, homing або ефекти pickup) підключаються композицією через `behaviors`.
 */
export class Entity {
  static #nextId = 1
  #id = Entity.#nextId++

  constructor({
    kind,
    x = 0,
    y = 0,
    vx = 0,
    vy = 0,
    angle = 0,
    radius = 12,
    behaviors = [],
  }) {
    this.kind = kind
    this.pos = new Vector2(x, y)
    this.prevPos = new Vector2(x, y)
    this.vel = new Vector2(vx, vy)
    this.angle = angle
    this.prevAngle = angle
    this.radius = radius
    this.alive = true
    this.behaviors = behaviors
  }

  get id() {
    return this.#id
  }

  snapshotPrevious() {
    this.prevPos.copy(this.pos)
    this.prevAngle = this.angle
  }

  update(dt) {
    this.pos.x += this.vel.x * dt
    this.pos.y += this.vel.y * dt
  }
}
