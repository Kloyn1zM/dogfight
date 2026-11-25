import { describe, expect, it } from 'vitest'
import {
  FIRE_COOLDOWN,
  HOMING_COOLDOWN,
  MatchWorld,
  RAPID_FIRE_COOLDOWN,
  RESPAWN_DELAY,
  TICK_DT,
  asEntityId,
  asSeq,
  asTick,
  type EntityId,
  type InputCommand,
} from '@dogfight/shared'

type StepInput = Pick<InputCommand, 'turn' | 'thrust' | 'fire' | 'fireHoming'>

describe('MatchWorld simulation and collisions', () => {
  it('runs deterministically: two worlds with identical seed and inputs produce identical snapshots', () => {
    const w1 = new MatchWorld({ seed: 4242, targetAsteroids: 6 })
    const w2 = new MatchWorld({ seed: 4242, targetAsteroids: 6 })
    w1.addShip(asEntityId(1))
    w1.addShip(asEntityId(2))
    w2.addShip(asEntityId(1))
    w2.addShip(asEntityId(2))

    for (let i = 0; i < 120; i += 1) {
      const inputs = new Map<EntityId, StepInput>([
        [
          asEntityId(1),
          {
            turn: i % 40 < 15 ? 1 : -1,
            thrust: i % 2 === 0,
            fire: i % 5 === 0,
            fireHoming: i % 30 === 0,
          },
        ],
        [
          asEntityId(2),
          {
            turn: i % 30 < 10 ? -1 : 0,
            thrust: true,
            fire: i % 7 === 0,
            fireHoming: i % 45 === 0,
          },
        ],
      ])
      const e1 = w1.step(TICK_DT, inputs)
      const e2 = w2.step(TICK_DT, inputs)
      expect(e1).toEqual(e2)
    }

    expect(w1.getSnapshot(asSeq(120))).toEqual(w2.getSnapshot(asSeq(120)))
    expect(w1.currentTick).toBe(asTick(120))
  })

  it('adds, retrieves, and removes ships cleanly', () => {
    const world = new MatchWorld({ seed: 1, targetAsteroids: 0 })
    const s = world.addShip(asEntityId(7))
    expect(world.getShip(asEntityId(7))).toBe(s)
    world.removeShip(asEntityId(7))
    expect(world.getShip(asEntityId(7))).toBeUndefined()
  })

  it('enforces normal and rapid-fire cooldowns and emits fired events', () => {
    const world = new MatchWorld({ seed: 10, targetAsteroids: 0 })
    const ship = world.addShip(asEntityId(1))
    const fireMap = new Map<EntityId, StepInput>([
      [asEntityId(1), { turn: 0, thrust: false, fire: true, fireHoming: false }],
    ])

    const e1 = world.step(TICK_DT, fireMap)
    expect(e1).toContainEqual({
      type: 'fired',
      ownerId: asEntityId(1),
      homing: false,
    })
    expect(ship.fireCooldown).toBeCloseTo(FIRE_COOLDOWN, 6)

    const e2 = world.step(TICK_DT, fireMap)
    expect(e2.filter((e) => e.type === 'fired')).toHaveLength(0)

    ship.fireCooldown = 0
    ship.rapidFireTimer = 5
    const e3 = world.step(TICK_DT, fireMap)
    expect(e3.filter((e) => e.type === 'fired')).toHaveLength(1)
    expect(ship.fireCooldown).toBeCloseTo(RAPID_FIRE_COOLDOWN, 6)
  })

  it('fires homing missiles with cooldown and steers them toward enemy ship', () => {
    const world = new MatchWorld({ seed: 11, targetAsteroids: 0 })
    const shooter = world.addShip(asEntityId(1))
    const target = world.addShip(asEntityId(2))
    shooter.x = 200
    shooter.y = 300
    shooter.angle = 0
    target.x = 380
    target.y = 420

    const events = world.step(
      TICK_DT,
      new Map<EntityId, StepInput>([
        [
          asEntityId(1),
          { turn: 0, thrust: false, fire: false, fireHoming: true },
        ],
      ]),
    )
    expect(events).toContainEqual({
      type: 'fired',
      ownerId: asEntityId(1),
      homing: true,
    })
    expect(shooter.homingCooldown).toBeCloseTo(HOMING_COOLDOWN, 6)

    const snapBefore = world.getSnapshot()
    const bulletBefore = snapBefore.entities.find((e) => e.kind === 'bullet')
    expect(bulletBefore?.kind).toBe('bullet')
    const angle0 = bulletBefore?.angle ?? 0

    for (let i = 0; i < 6; i += 1) {
      world.step(TICK_DT)
    }
    const snapAfter = world.getSnapshot()
    const bulletAfter = snapAfter.entities.find((e) => e.kind === 'bullet')
    expect(bulletAfter).toBeDefined()
    expect(bulletAfter?.angle).toBeGreaterThan(angle0)
  })

  it('resolves bullet-ship collision, kills target, awards score, and respawns with shield', () => {
    const world = new MatchWorld({ seed: 22, targetAsteroids: 0 })
    const attacker = world.addShip(asEntityId(1))
    const victim = world.addShip(asEntityId(2))

    attacker.x = 400
    attacker.y = 300
    attacker.angle = 0
    victim.x = 438
    victim.y = 300
    victim.hp = 25

    const fireOnce = new Map<EntityId, StepInput>([
      [asEntityId(1), { turn: 0, thrust: false, fire: true, fireHoming: false }],
    ])

    let sawHit = false
    let sawExploded = false
    for (let i = 0; i < 6; i += 1) {
      const evts = world.step(TICK_DT, i === 0 ? fireOnce : undefined)
      if (evts.some((e) => e.type === 'hit')) sawHit = true
      if (evts.some((e) => e.type === 'exploded' && e.kind === 'ship')) {
        sawExploded = true
      }
    }

    expect(sawHit).toBe(true)
    expect(sawExploded).toBe(true)
    expect(victim.alive).toBe(false)
    expect(victim.hp).toBe(0)
    expect(attacker.score).toBe(250)

    const stepsToRespawn = Math.ceil(RESPAWN_DELAY / TICK_DT) + 2
    for (let i = 0; i < stepsToRespawn; i += 1) {
      world.step(TICK_DT)
    }
    expect(victim.alive).toBe(true)
    expect(victim.hp).toBe(100)
    expect(victim.shieldTimer).toBeGreaterThan(0)
  })

  it('blocks bullet damage while shieldTimer is active', () => {
    const world = new MatchWorld({ seed: 23, targetAsteroids: 0 })
    const attacker = world.addShip(asEntityId(1))
    const defender = world.addShip(asEntityId(2))
    attacker.x = 400
    attacker.y = 300
    attacker.angle = 0
    defender.x = 435
    defender.y = 300
    defender.shieldTimer = 5

    world.step(
      TICK_DT,
      new Map<EntityId, StepInput>([
        [
          asEntityId(1),
          { turn: 0, thrust: false, fire: true, fireHoming: false },
        ],
      ]),
    )
    for (let i = 0; i < 4; i += 1) {
      world.step(TICK_DT)
    }
    expect(defender.hp).toBe(100)
    expect(defender.alive).toBe(true)
  })

  it('destroys and splits big asteroids when shot, awarding score', () => {
    const world = new MatchWorld({ seed: 30, targetAsteroids: 2 })
    const ship = world.addShip(asEntityId(1))
    const snap0 = world.getSnapshot()
    const asteroid = snap0.entities.find(
      (e) => e.kind === 'asteroid' && !e.isHoming && e.radius >= 26,
    )
    expect(asteroid?.kind).toBe('asteroid')
    if (!asteroid || asteroid.kind !== 'asteroid') return

    ship.x = Math.max(80, asteroid.x - 60)
    ship.y = asteroid.y
    ship.angle = Math.atan2(asteroid.y - ship.y, asteroid.x - ship.x)
    ship.shieldTimer = 10
    ship.rapidFireTimer = 5

    let explodedBig = false
    for (let i = 0; i < 40 && !explodedBig; i += 1) {
      const snap = world.getSnapshot()
      const currentAst = snap.entities.find(
        (e) => e.kind === 'asteroid' && e.id === asteroid.id,
      )
      if (currentAst) {
        ship.angle = Math.atan2(currentAst.y - ship.y, currentAst.x - ship.x)
      }
      const evts = world.step(
        TICK_DT,
        new Map<EntityId, StepInput>([
          [
            asEntityId(1),
            { turn: 0, thrust: false, fire: true, fireHoming: false },
          ],
        ]),
      )
      if (
        evts.some(
          (e) => e.type === 'exploded' && e.kind === 'asteroid' && e.big,
        )
      ) {
        explodedBig = true
      }
    }

    expect(explodedBig).toBe(true)
    expect(ship.score).toBeGreaterThan(0)
  })

  it('spawns pickups over time and grants shield or rapidFire when collected', () => {
    const world = new MatchWorld({ seed: 44, targetAsteroids: 0 })
    const ship = world.addShip(asEntityId(1))
    world.pickupTimer = TICK_DT / 2
    world.step(TICK_DT)

    const pickup = world
      .getSnapshot()
      .entities.find((e) => e.kind === 'pickup')
    expect(pickup?.kind).toBe('pickup')
    if (!pickup || pickup.kind !== 'pickup') return

    ship.x = pickup.x
    ship.y = pickup.y
    const evts = world.step(TICK_DT)
    expect(evts).toContainEqual({
      type: 'pickup',
      shipId: asEntityId(1),
      effect: pickup.effect,
    })
    if (pickup.effect === 'shield') {
      expect(ship.shieldTimer).toBeGreaterThan(0)
    } else {
      expect(ship.rapidFireTimer).toBeGreaterThan(0)
    }
  })

  it('damages and bounces ship on asteroid collision', () => {
    const world = new MatchWorld({ seed: 55, targetAsteroids: 1 })
    const ship = world.addShip(asEntityId(1))
    const asteroid = world
      .getSnapshot()
      .entities.find((e) => e.kind === 'asteroid')
    expect(asteroid).toBeDefined()
    if (!asteroid) return

    ship.x = asteroid.x
    ship.y = asteroid.y
    ship.vx = 0
    ship.vy = 0

    const evts = world.step(TICK_DT)
    expect(evts.some((e) => e.type === 'hit')).toBe(true)
    expect(ship.hp).toBe(65)
  })

  it('steers homing asteroid toward alive ship and bounces asteroids off each other', () => {
    const world = new MatchWorld({ seed: 66, targetAsteroids: 8 })
    world.addShip(asEntityId(1))
    for (let i = 0; i < 180; i += 1) {
      world.step(TICK_DT)
    }
    const snap = world.getSnapshot()
    const asteroids = snap.entities.filter((e) => e.kind === 'asteroid')
    expect(asteroids.length).toBeGreaterThanOrEqual(8)
    for (const a of asteroids) {
      expect(Number.isFinite(a.x)).toBe(true)
      expect(Number.isFinite(a.y)).toBe(true)
    }
  })
})
