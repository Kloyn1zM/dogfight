import { describe, expect, it, vi } from 'vitest'
import {
  MatchWorld,
  TICK_DT,
  asEntityId,
  asSeq,
  asTick,
  type EntityId,
  type InputCommand,
  type Snapshot,
} from '@dogfight/shared'
import { NetWorld } from '../src/net/netWorld.ts'

describe('NetWorld client prediction, server reconciliation, and interpolation', () => {
  it('predicts local ship movement immediately and reconciles with ~0px error when server matches', () => {
    const serverWorld = new MatchWorld({ seed: 100, targetAsteroids: 0 })
    const shipId = asEntityId(1)
    serverWorld.addShip(shipId)

    const netWorld = new NetWorld()
    netWorld.setWelcome({ shipId, tick: asTick(0) })
    netWorld.onSnapshot(serverWorld.getSnapshot(asSeq(0)), 1000)

    const sent: InputCommand[] = []
    for (let i = 0; i < 6; i += 1) {
      const cmd = netWorld.stepLocal(
        { turn: 1, thrust: true, fire: false, fireHoming: false },
        TICK_DT,
      )
      expect(cmd).not.toBeNull()
      if (cmd) sent.push(cmd)
    }

    // Server processes only first 3 inputs (simulating RTT lag)
    for (let i = 0; i < 3; i += 1) {
      const inp = sent[i]
      if (!inp) continue
      serverWorld.step(
        TICK_DT,
        new Map<
          EntityId,
          Pick<InputCommand, 'turn' | 'thrust' | 'fire' | 'fireHoming'>
        >([[shipId, inp]]),
      )
    }

    const snapAt3 = serverWorld.getSnapshot(asSeq(3))
    netWorld.onSnapshot(snapAt3, 1100)

    const metrics = netWorld.getMetrics(1100)
    expect(metrics.pendingInputs).toBe(3)
    expect(metrics.lastCorrectionPx).toBeLessThan(0.01)
  })

  it('smooths visual error when server state diverges from predicted state', () => {
    const netWorld = new NetWorld()
    const shipId = asEntityId(1)
    netWorld.setWelcome({ shipId, tick: asTick(0) })

    const makeSnap = (tick: number, ackSeq: number, x: number): Snapshot => ({
      tick: asTick(tick),
      lastProcessedSeq: asSeq(ackSeq),
      matchTimeMs: tick * 33,
      entities: [
        {
          id: shipId,
          kind: 'ship',
          x,
          y: 360,
          vx: 0,
          vy: 0,
          angle: 0,
          thrusting: false,
          shieldActive: false,
          rapidFireActive: false,
          alive: true,
          hp: 100,
          score: 0,
        },
      ],
    })

    netWorld.onSnapshot(makeSnap(1, 0, 500), 100)
    netWorld.stepLocal(
      { turn: 0, thrust: false, fire: false, fireHoming: false },
      TICK_DT,
    )

    // Server teleports ship by 40px (e.g. unexpected collision bounce)
    netWorld.onSnapshot(makeSnap(2, 1, 540), 133)
    expect(netWorld.getMetrics(133).lastCorrectionPx).toBeCloseTo(40, 1)

    const rsBefore = netWorld.getRenderState(133, 1)
    const shipBefore = rsBefore.entities.find(
      (e) => e.kind === 'ship' && e.isLocal,
    )
    expect(shipBefore).toBeDefined()
    // Visual position stays near 500 initially and decays toward 540
    expect(shipBefore?.x).toBeCloseTo(500, 0)

    for (let i = 0; i < 15; i += 1) {
      netWorld.stepLocal(
        { turn: 0, thrust: false, fire: false, fireHoming: false },
        TICK_DT,
      )
    }
    const rsAfter = netWorld.getRenderState(600, 1)
    const shipAfter = rsAfter.entities.find(
      (e) => e.kind === 'ship' && e.isLocal,
    )
    expect(shipAfter?.x).toBeCloseTo(540, 0)
  })

  it('interpolates remote ships between two buffered snapshots in the past', () => {
    const netWorld = new NetWorld()
    netWorld.interpolationDelayMs = 100
    netWorld.setWelcome({ shipId: asEntityId(1), tick: asTick(0) })
    netWorld.setRoster([
      { id: 'p1', shipId: asEntityId(1), name: 'Me' },
      { id: 'p2', shipId: asEntityId(2), name: 'Rival' },
    ])

    const makeRemoteSnap = (tick: number, x: number): Snapshot => ({
      tick: asTick(tick),
      lastProcessedSeq: asSeq(0),
      matchTimeMs: tick * 33,
      entities: [
        {
          id: asEntityId(2),
          kind: 'ship',
          x,
          y: 200,
          vx: 100,
          vy: 0,
          angle: 0,
          thrusting: true,
          shieldActive: false,
          rapidFireActive: false,
          alive: true,
          hp: 100,
          score: 0,
        },
      ],
    })

    netWorld.onSnapshot(makeRemoteSnap(1, 100), 1000)
    netWorld.onSnapshot(makeRemoteSnap(2, 200), 1100)

    // now = 1150 -> renderTime = 1050 (midpoint between 1000 and 1100)
    const rs = netWorld.getRenderState(1150, 0)
    const rival = rs.entities.find(
      (e) => e.kind === 'ship' && e.id === asEntityId(2),
    )
    expect(rival?.kind).toBe('ship')
    if (rival?.kind === 'ship') {
      expect(rival.x).toBeCloseTo(150, 5)
      expect(rival.name).toBe('Rival')
    }
  })

  it('spawns predicted local bullets immediately and removes them when server bullet arrives', () => {
    const netWorld = new NetWorld()
    const shipId = asEntityId(1)
    netWorld.setWelcome({ shipId, tick: asTick(0) })

    netWorld.onSnapshot(
      {
        tick: asTick(1),
        lastProcessedSeq: asSeq(0),
        matchTimeMs: 33,
        entities: [
          {
            id: shipId,
            kind: 'ship',
            x: 300,
            y: 300,
            vx: 0,
            vy: 0,
            angle: 0,
            thrusting: false,
            shieldActive: false,
            rapidFireActive: false,
            alive: true,
            hp: 100,
            score: 0,
          },
        ],
      },
      100,
    )

    netWorld.stepLocal(
      { turn: 0, thrust: false, fire: true, fireHoming: false },
      TICK_DT,
    )
    const rs1 = netWorld.getRenderState(100, 1)
    const pred = rs1.entities.filter((e) => e.kind === 'bullet' && e.predicted)
    expect(pred).toHaveLength(1)
    const predBullet = pred[0]
    expect(predBullet).toBeDefined()
    if (!predBullet) return

    // Server confirms bullet near predicted position
    netWorld.onSnapshot(
      {
        tick: asTick(2),
        lastProcessedSeq: asSeq(1),
        matchTimeMs: 66,
        entities: [
          {
            id: shipId,
            kind: 'ship',
            x: 300,
            y: 300,
            vx: 0,
            vy: 0,
            angle: 0,
            thrusting: false,
            shieldActive: false,
            rapidFireActive: false,
            alive: true,
            hp: 100,
            score: 0,
          },
          {
            id: asEntityId(101),
            kind: 'bullet',
            x: predBullet.x + 2,
            y: predBullet.y,
            vx: 540,
            vy: 0,
            angle: 0,
            isHoming: false,
            ownerId: shipId,
          },
        ],
      },
      133,
    )

    const rs2 = netWorld.getRenderState(250, 1)
    const predAfter = rs2.entities.filter(
      (e) => e.kind === 'bullet' && e.predicted,
    )
    expect(predAfter).toHaveLength(0)
  })

  it('forwards server match events to TypedBus and spawns explosion particles', () => {
    const netWorld = new NetWorld()
    netWorld.setWelcome({ shipId: asEntityId(1), tick: asTick(0) })

    const firedSpy = vi.fn()
    const pickupSpy = vi.fn()
    const explodedSpy = vi.fn()
    netWorld.events.on('fired', firedSpy)
    netWorld.events.on('pickup', pickupSpy)
    netWorld.events.on('exploded', explodedSpy)

    netWorld.onServerEvents([
      { type: 'fired', ownerId: asEntityId(1), homing: false },
      { type: 'pickup', shipId: asEntityId(1), effect: 'shield' },
      { type: 'pickup', shipId: asEntityId(2), effect: 'rapidFire' },
      { type: 'exploded', kind: 'asteroid', big: true, x: 400, y: 250 },
    ])

    expect(firedSpy).toHaveBeenCalledTimes(1)
    expect(pickupSpy).toHaveBeenCalledTimes(1)
    expect(pickupSpy).toHaveBeenCalledWith({ effect: 'shield' })
    expect(explodedSpy).toHaveBeenCalledTimes(1)

    const rs = netWorld.getRenderState(0, 0)
    expect(rs.explosions).toHaveLength(1)
    expect(rs.explosions[0]?.particles.length).toBe(20)
  })

  it('ignores out-of-order snapshots with older tick numbers', () => {
    const netWorld = new NetWorld()
    netWorld.setWelcome({ shipId: asEntityId(1), tick: asTick(5) })

    netWorld.onSnapshot(
      {
        tick: asTick(10),
        lastProcessedSeq: asSeq(0),
        matchTimeMs: 333,
        entities: [],
      },
      100,
    )
    netWorld.onSnapshot(
      {
        tick: asTick(8),
        lastProcessedSeq: asSeq(0),
        matchTimeMs: 266,
        entities: [],
      },
      120,
    )

    expect(netWorld.getMetrics(120).tick).toBe(10)
    expect(netWorld.getMetrics(120).bufferSize).toBe(1)
  })

  it('emits score event on score increase and clears pending inputs on death', () => {
    const netWorld = new NetWorld()
    const shipId = asEntityId(1)
    netWorld.setWelcome({ shipId, tick: asTick(0) })
    const scoreSpy = vi.fn()
    netWorld.events.on('score', scoreSpy)

    netWorld.onSnapshot(
      {
        tick: asTick(1),
        lastProcessedSeq: asSeq(0),
        matchTimeMs: 33,
        entities: [
          {
            id: shipId,
            kind: 'ship',
            x: 100,
            y: 100,
            vx: 0,
            vy: 0,
            angle: 0,
            thrusting: false,
            shieldActive: false,
            rapidFireActive: false,
            alive: true,
            hp: 100,
            score: 100,
          },
        ],
      },
      100,
    )

    expect(scoreSpy).toHaveBeenCalledWith({ delta: 100, total: 100 })

    netWorld.stepLocal(
      { turn: 0, thrust: true, fire: false, fireHoming: false },
      TICK_DT,
    )
    expect(netWorld.getMetrics(110).pendingInputs).toBe(1)

    netWorld.onSnapshot(
      {
        tick: asTick(2),
        lastProcessedSeq: asSeq(0),
        matchTimeMs: 66,
        entities: [
          {
            id: shipId,
            kind: 'ship',
            x: 100,
            y: 100,
            vx: 0,
            vy: 0,
            angle: 0,
            thrusting: false,
            shieldActive: false,
            rapidFireActive: false,
            alive: false,
            hp: 0,
            score: 100,
          },
        ],
      },
      133,
    )

    expect(netWorld.getMetrics(133).pendingInputs).toBe(0)
  })

  it('reuses pooled predicted bullets, explosion particles, and binary snapshot slots', () => {
    const serverWorld = new MatchWorld({ seed: 55, targetAsteroids: 4 })
    const shipId = asEntityId(1)
    serverWorld.addShip(shipId)

    const netWorld = new NetWorld()
    netWorld.setWelcome({ shipId, tick: asTick(0) })

    for (let i = 0; i < 40; i += 1) {
      serverWorld.step(TICK_DT)
      const snap = serverWorld.getSnapshot(asSeq(i))
      netWorld.onSnapshot(snap, 100 + i * 33)
      netWorld.stepLocal(
        { turn: 0, thrust: false, fire: true, fireHoming: false },
        TICK_DT,
      )
      if (i % 5 === 0) {
        netWorld.onServerEvents([
          { type: 'exploded', kind: 'asteroid', big: false, x: 200, y: 200 },
        ])
      }
      netWorld.getRenderState(100 + i * 33, 0.5)
    }

    // Advance enough ticks for explosions and predicted bullets to expire and return to pool
    for (let i = 0; i < 30; i += 1) {
      netWorld.stepLocal(
        { turn: 0, thrust: false, fire: false, fireHoming: false },
        TICK_DT,
      )
    }
    netWorld.onServerEvents([
      { type: 'exploded', kind: 'asteroid', big: false, x: 300, y: 300 },
    ])

    const stats = netWorld.getPoolStats()
    expect(stats.predictedBulletsReused).toBeGreaterThan(0)
    expect(stats.particlesReused).toBeGreaterThan(0)
    expect(stats.explosionsReused).toBeGreaterThan(0)
  })
})
