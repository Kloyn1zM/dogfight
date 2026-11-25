import { describe, expect, it } from 'vitest'
import {
  MatchWorld,
  ObjectPool,
  SpatialHashGrid,
  TICK_DT,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  asEntityId,
  asSeq,
  binaryCodec,
  createReusableSnapshotBuffer,
  decodeSnapshotBinaryInto,
  type EntityId,
  type InputCommand,
} from '@dogfight/shared'

type StepInput = Pick<InputCommand, 'turn' | 'thrust' | 'fire' | 'fireHoming'>

describe('ObjectPool, SpatialHashGrid equivalence, and pooled binary decoding', () => {
  it('ObjectPool reuses released items and invokes optional reset hook', () => {
    const pool = new ObjectPool(() => ({ x: 0, active: false }), {
      initialSize: 2,
      maxSize: 4,
      reset(item) {
        item.x = 0
        item.active = false
      },
    })

    expect(pool.created).toBe(2)
    expect(pool.available).toBe(2)

    const a = pool.acquire()
    a.x = 42
    a.active = true
    expect(pool.reused).toBe(1)

    pool.release(a)
    expect(a.x).toBe(0)
    expect(a.active).toBe(false)

    const b = pool.acquire()
    expect(b).toBe(a)
    expect(pool.reused).toBe(2)
  })

  it('SpatialHashGrid finds overlapping bodies in exact insertion order without duplicates', () => {
    const grid = new SpatialHashGrid<{
      id: EntityId
      x: number
      y: number
      radius: number
    }>(WORLD_WIDTH, WORLD_HEIGHT, 64)

    const bodies = [
      { id: asEntityId(10), x: 64, y: 64, radius: 20 },
      { id: asEntityId(5), x: 70, y: 66, radius: 20 },
      { id: asEntityId(20), x: 500, y: 500, radius: 15 },
      { id: asEntityId(3), x: 58, y: 60, radius: 20 },
    ]
    for (const b of bodies) grid.insert(b)

    const out: typeof bodies = []
    grid.queryCircle(64, 64, 30, out)
    expect(out.map((b) => b.id)).toEqual([
      asEntityId(10),
      asEntityId(5),
      asEntityId(3),
    ])

    grid.clear()
    grid.queryCircle(64, 64, 30, out)
    expect(out).toHaveLength(0)
  })

  it('MatchWorld with SpatialHashGrid is bit-for-bit equivalent to naive O(n^2) over 120 ticks', () => {
    const spatialWorld = new MatchWorld({
      seed: 9001,
      targetAsteroids: 12,
      collisionMode: 'spatial',
    })
    const naiveWorld = new MatchWorld({
      seed: 9001,
      targetAsteroids: 12,
      collisionMode: 'naive',
    })

    for (let id = 1; id <= 8; id += 1) {
      spatialWorld.addShip(asEntityId(id))
      naiveWorld.addShip(asEntityId(id))
    }

    for (let t = 0; t < 120; t += 1) {
      const inputs = new Map<EntityId, StepInput>()
      for (let id = 1; id <= 8; id += 1) {
        inputs.set(asEntityId(id), {
          turn: (t + id) % 30 < 10 ? 1 : (t + id) % 30 < 20 ? -1 : 0,
          thrust: (t + id) % 3 !== 0,
          fire: (t + id) % 4 === 0,
          fireHoming: (t + id) % 29 === 0,
        })
      }

      const evSpatial = spatialWorld.step(TICK_DT, inputs)
      const evNaive = naiveWorld.step(TICK_DT, inputs)
      expect(evSpatial).toEqual(evNaive)
    }

    expect(spatialWorld.getSnapshot(asSeq(120))).toEqual(
      naiveWorld.getSnapshot(asSeq(120)),
    )
    expect(spatialWorld.getPoolStats().bulletsReused).toBeGreaterThan(0)
  })

  it('decodeSnapshotBinaryInto matches decodeSnapshotBinary and reuses entity slots', () => {
    const world = new MatchWorld({ seed: 1234, targetAsteroids: 6 })
    world.addShip(asEntityId(1))
    world.addShip(asEntityId(2))
    const inputs = new Map<EntityId, StepInput>([
      [asEntityId(1), { turn: 1, thrust: true, fire: true, fireHoming: false }],
      [asEntityId(2), { turn: -1, thrust: true, fire: true, fireHoming: true }],
    ])
    for (let t = 0; t < 30; t += 1) {
      world.step(TICK_DT, inputs)
    }

    const buf = createReusableSnapshotBuffer()
    const raw1 = binaryCodec.encodeSnapshot(world.getSnapshot(asSeq(30)))
    const expected1 = binaryCodec.decodeSnapshot(raw1)
    const pooled1 = decodeSnapshotBinaryInto(raw1, buf)

    expect(pooled1.tick).toBe(expected1.tick)
    expect(pooled1.lastProcessedSeq).toBe(expected1.lastProcessedSeq)
    expect(pooled1.entities).toEqual(expected1.entities)

    const shipsCapacity = buf.ships.length
    world.step(TICK_DT, inputs)
    const raw2 = binaryCodec.encodeSnapshot(world.getSnapshot(asSeq(31)))
    const expected2 = binaryCodec.decodeSnapshot(raw2)
    const pooled2 = decodeSnapshotBinaryInto(raw2, buf)

    expect(pooled2.entities).toEqual(expected2.entities)
    expect(buf.ships.length).toBe(shipsCapacity)
  })
})
