import { Entity } from './entity.js'
import { createPickupEffect, hasBehavior, runBehaviors } from './behaviors.js'

export class Bullet extends Entity {
  constructor({
    x,
    y,
    vx,
    vy,
    angle,
    ownerId,
    ttl = 1.6,
    damage = 25,
    behaviors = [],
  }) {
    super({ kind: 'bullet', x, y, vx, vy, angle, radius: 4, behaviors })
    this.ownerId = ownerId
    this.ttl = ttl
    this.damage = damage
  }

  get isHoming() {
    return hasBehavior(this, 'homing')
  }

  update(dt, world) {
    runBehaviors(this, dt, world)
    super.update(dt)
    this.ttl -= dt
    if (this.ttl <= 0) this.alive = false
  }
}

export class Asteroid extends Entity {
  constructor({
    x,
    y,
    vx,
    vy,
    radius = 28,
    hp = 50,
    spin = 1.1,
    points = 100,
    behaviors = [],
  }) {
    super({
      kind: 'asteroid',
      x,
      y,
      vx,
      vy,
      angle: Math.atan2(vy, vx),
      radius,
      behaviors,
    })
    this.hp = hp
    this.maxHp = hp
    this.spin = spin
    this.visualAngle = Math.random() * Math.PI * 2
    this.points = points
  }

  get isHoming() {
    return hasBehavior(this, 'homing')
  }

  takeDamage(amount) {
    if (!this.alive) return false
    this.hp -= amount
    if (this.hp <= 0) {
      this.hp = 0
      this.alive = false
      return true
    }
    return false
  }

  update(dt, world) {
    runBehaviors(this, dt, world)
    super.update(dt)
    this.visualAngle += this.spin * dt
  }
}

export class Pickup extends Entity {
  constructor({ x, y, effect = 'shield', duration = 6, ttl = 12 }) {
    super({
      kind: 'pickup',
      x,
      y,
      vx: 0,
      vy: 0,
      radius: 13,
      behaviors: [createPickupEffect({ effect, duration })],
    })
    this.effect = effect
    this.ttl = ttl
  }

  update(dt) {
    this.angle += 1.8 * dt
    this.ttl -= dt
    if (this.ttl <= 0) this.alive = false
  }
}

export class Explosion extends Entity {
  constructor({
    x,
    y,
    count = 16,
    color = '#fb923c',
    speed = 190,
    ttl = 0.55,
  }) {
    super({ kind: 'explosion', x, y, radius: 0 })
    this.ttl = ttl
    this.maxTtl = ttl
    this.color = color
    this.particles = []

    for (let i = 0; i < count; i += 1) {
      const a = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4
      const spd = speed * (0.35 + Math.random() * 0.75)
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd,
        r: 1.5 + Math.random() * 2.5,
      })
    }
  }

  update(dt) {
    const drag = Math.exp(-3.2 * dt)
    for (const p of this.particles) {
      p.vx *= drag
      p.vy *= drag
      p.x += p.vx * dt
      p.y += p.vy * dt
    }
    this.ttl -= dt
    if (this.ttl <= 0) this.alive = false
  }
}
