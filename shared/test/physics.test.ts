import { describe, expect, it } from 'vitest'
import {
  MAX_SPEED,
  ROTATE_SPEED,
  TICK_DT,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  asEntityId,
  asSeq,
  asTick,
  bouncePosition,
  cloneShipState,
  createShipState,
  hashShipState,
  integrateShip,
  normalizeAngle,
  normalizeInput,
  shortestAngleDiff,
  wrapPosition,
} from '@dogfight/shared'

describe('physics helpers and ship integration', () => {
  it('normalizeAngle maps any angle into (-pi, pi]', () => {
    expect(normalizeAngle(0)).toBeCloseTo(0, 10)
    expect(normalizeAngle(Math.PI)).toBeCloseTo(Math.PI, 10)
    expect(normalizeAngle(-Math.PI)).toBeCloseTo(Math.PI, 10)
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 10)
    expect(normalizeAngle(-3.5 * Math.PI)).toBeCloseTo(0.5 * Math.PI, 10)
  })

  it('shortestAngleDiff chooses the minimal arc across +/-pi boundary', () => {
    const diffPos = shortestAngleDiff(Math.PI - 0.1, -Math.PI + 0.1)
    expect(diffPos).toBeCloseTo(0.2, 10)

    const diffNeg = shortestAngleDiff(-Math.PI + 0.1, Math.PI - 0.1)
    expect(diffNeg).toBeCloseTo(-0.2, 10)
  })

  it('normalizeInput sanitizes partial input and clamps turn to -1 | 0 | 1', () => {
    expect(normalizeInput()).toEqual({
      seq: asSeq(0),
      tick: asTick(0),
      turn: 0,
      thrust: false,
      fire: false,
      fireHoming: false,
    })

    expect(
      normalizeInput({
        seq: 7,
        tick: 15,
        turn: 42,
        thrust: true,
        fire: true,
        fireHoming: false,
      }),
    ).toEqual({
      seq: asSeq(7),
      tick: asTick(15),
      turn: 1,
      thrust: true,
      fire: true,
      fireHoming: false,
    })

    const bad = normalizeInput({ seq: -5, tick: 1.5, turn: -99 })
    expect(bad.seq).toBe(asSeq(0))
    expect(bad.tick).toBe(asTick(0))
    expect(bad.turn).toBe(-1)
  })

  it('cloneShipState creates an independent shallow copy', () => {
    const a = createShipState({ id: asEntityId(5), x: 100, y: 200 })
    const b = cloneShipState(a)
    b.x = 500
    b.hp = 10
    expect(a.x).toBe(100)
    expect(a.hp).toBe(100)
  })

  it('wrapPosition wraps negative and overflow coordinates cleanly', () => {
    const pos = { x: -10, y: WORLD_HEIGHT + 25 }
    wrapPosition(pos, WORLD_WIDTH, WORLD_HEIGHT)
    expect(pos.x).toBe(WORLD_WIDTH - 10)
    expect(pos.y).toBe(25)
  })

  it('bouncePosition reflects velocity on all four arena edges', () => {
    const e1 = { x: 2, y: 3, vx: -50, vy: -40, radius: 10 }
    bouncePosition(e1, 200, 100)
    expect(e1.x).toBe(10)
    expect(e1.y).toBe(10)
    expect(e1.vx).toBe(50)
    expect(e1.vy).toBe(40)

    const e2 = { x: 198, y: 97, vx: 50, vy: 40, radius: 10 }
    bouncePosition(e2, 200, 100)
    expect(e2.x).toBe(190)
    expect(e2.y).toBe(90)
    expect(e2.vx).toBe(-50)
    expect(e2.vy).toBe(-40)
  })

  it('rotates ship left and right by ROTATE_SPEED * dt', () => {
    const ship = createShipState({ angle: 0 })
    integrateShip(ship, { turn: 1, thrust: false }, TICK_DT)
    expect(ship.angle).toBeCloseTo(ROTATE_SPEED * TICK_DT, 10)

    integrateShip(ship, { turn: -1, thrust: false }, TICK_DT)
    expect(ship.angle).toBeCloseTo(0, 10)
  })

  it('applies thrust acceleration and exponential drag when coasting', () => {
    const ship = createShipState({ x: 300, y: 300, angle: 0 })
    integrateShip(ship, { turn: 0, thrust: true }, TICK_DT)
    expect(ship.vx).toBeGreaterThan(0)
    expect(ship.x).toBeGreaterThan(300)

    const prevVx = ship.vx
    integrateShip(ship, { turn: 0, thrust: false }, TICK_DT)
    expect(ship.vx).toBeLessThan(prevVx)
    expect(ship.thrust).toBe(0)
  })

  it('caps ship speed at MAX_SPEED under continuous thrust', () => {
    const ship = createShipState({ angle: 0 })
    for (let i = 0; i < 300; i += 1) {
      integrateShip(ship, { turn: 0, thrust: true }, TICK_DT)
    }
    expect(Math.hypot(ship.vx, ship.vy)).toBeLessThanOrEqual(MAX_SPEED + 1e-6)
  })

  it('does not move or decay cooldowns when ship is dead', () => {
    const ship = createShipState({ x: 120, y: 120, angle: 0 })
    ship.alive = false
    ship.fireCooldown = 1
    integrateShip(ship, { turn: 1, thrust: true }, TICK_DT)
    expect(ship.x).toBe(120)
    expect(ship.y).toBe(120)
    expect(ship.angle).toBe(0)
    expect(ship.fireCooldown).toBe(1)
  })

  it('decays all ship timers down to zero without going negative', () => {
    const ship = createShipState()
    ship.fireCooldown = 0.01
    ship.homingCooldown = 0.5
    ship.shieldTimer = 0.02
    ship.rapidFireTimer = 1.0

    integrateShip(ship, { turn: 0, thrust: false }, TICK_DT)
    expect(ship.fireCooldown).toBe(0)
    expect(ship.homingCooldown).toBeCloseTo(0.5 - TICK_DT, 10)
    expect(ship.shieldTimer).toBe(0)
    expect(ship.rapidFireTimer).toBeCloseTo(1.0 - TICK_DT, 10)
  })

  it('wraps ship coordinates seamlessly across arena edges', () => {
    const ship = createShipState({ x: WORLD_WIDTH - 1, y: 100, angle: 0 })
    ship.vx = 300
    integrateShip(ship, { turn: 0, thrust: false }, TICK_DT)
    expect(ship.x).toBeGreaterThanOrEqual(0)
    expect(ship.x).toBeLessThan(30)
  })

  it('preserves exact 1000-step determinism hash babcfb7b', () => {
    const ship = createShipState({
      id: asEntityId(1),
      x: 640,
      y: 360,
      angle: -Math.PI / 2,
    })
    for (let i = 0; i < 1000; i += 1) {
      const turn = i % 30 < 10 ? 1 : i % 30 < 20 ? -1 : 0
      const thrust = i % 3 !== 0
      integrateShip(ship, { turn, thrust }, TICK_DT)
    }
    expect(hashShipState(ship)).toBe('babcfb7b')
  })
})
