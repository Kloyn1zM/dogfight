import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MatchWorld,
  PROTOCOL_VERSION,
  TICK_DT,
  asEntityId,
  asSeq,
  asTick,
  binaryCodec,
  createShipState,
  hashShipState,
  integrateShip,
  jsonCodec,
  parseClientMessage,
  type EntityId,
  type InputCommand,
} from '@dogfight/shared'
import { loadConfig } from '../src/config.ts'
import { Match } from '../src/match.ts'
import { NetSimulator } from '../src/netSim.ts'
import { RoomManager, type RoomPlayer } from '../src/rooms.ts'
import { readReplayEvents } from '../src/log/replay.ts'

describe('server config, rooms, match, netSim, and match log', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('loadConfig validates env via Zod and rejects invalid PORT', () => {
    const defaults = loadConfig({})
    expect(defaults.port).toBe(3000)
    expect(defaults.maxRooms).toBe(20)
    expect(defaults.enableSlowDemo).toBe(false)

    const custom = loadConfig({ PORT: '4000', ENABLE_SLOW_DEMO: '1', HOST: '' })
    expect(custom.port).toBe(4000)
    expect(custom.host).toBe('127.0.0.1')
    expect(custom.enableSlowDemo).toBe(true)

    expect(() => loadConfig({ PORT: 'not-a-number' })).toThrow(
      /Invalid server config/,
    )
    expect(() => loadConfig({ PORT: '99999' })).toThrow(/Invalid server config/)
  })

  it('parseClientMessage (Zod) accepts valid join, chat and input', () => {
    const joinRes = parseClientMessage(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'join',
        room: 'nebula-alpha',
        name: 'Ace',
      }),
    )
    expect(joinRes.ok).toBe(true)
    if (joinRes.ok && joinRes.value.type === 'join') {
      expect(joinRes.value.name).toBe('Ace')
      expect(joinRes.value.codec).toBe('binary')
    }

    const chatRes = parseClientMessage(
      JSON.stringify({ v: PROTOCOL_VERSION, type: 'chat', text: 'Привіт!' }),
    )
    expect(chatRes.ok).toBe(true)

    const inputRes = parseClientMessage(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'input',
        seq: 12,
        tick: 40,
        turn: -1,
        thrust: true,
        fire: false,
      }),
    )
    expect(inputRes.ok).toBe(true)
    if (inputRes.ok && inputRes.value.type === 'input') {
      expect(inputRes.value.turn).toBe(-1)
    }
  })

  it('parseClientMessage rejects cheat turn, bad version and unknown type', () => {
    expect(parseClientMessage('{broken').ok).toBe(false)
    expect(
      parseClientMessage(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'input',
          seq: 1,
          turn: 1000,
        }),
      ).ok,
    ).toBe(false)
    expect(
      parseClientMessage(JSON.stringify({ v: 99, type: 'chat', text: 'hi' }))
        .ok,
    ).toBe(false)
    expect(
      parseClientMessage(
        JSON.stringify({ v: PROTOCOL_VERSION, type: 'teleport' }),
      ).ok,
    ).toBe(false)
  })

  it('shared simulation stays bit-identical (hash babcfb7b)', () => {
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

  it('binary DataView codec round-trips input and snapshot within tolerance', () => {
    const input: InputCommand = {
      seq: asSeq(4242),
      tick: asTick(9001),
      turn: -1,
      thrust: true,
      fire: false,
      fireHoming: true,
    }
    const decodedInput = binaryCodec.decodeInput(binaryCodec.encodeInput(input))
    expect(decodedInput).toEqual(input)

    const world = new MatchWorld({ seed: 777, targetAsteroids: 4 })
    world.addShip(asEntityId(1))
    world.addShip(asEntityId(2))
    const inputs = new Map<
      EntityId,
      Pick<InputCommand, 'turn' | 'thrust' | 'fire' | 'fireHoming'>
    >([
      [asEntityId(1), { turn: 1, thrust: true, fire: true, fireHoming: false }],
      [asEntityId(2), { turn: -1, thrust: true, fire: false, fireHoming: true }],
    ])
    for (let i = 0; i < 20; i += 1) {
      world.step(TICK_DT, inputs)
    }

    const snap = world.getSnapshot(asSeq(19))
    const decoded = binaryCodec.decodeSnapshot(binaryCodec.encodeSnapshot(snap))

    expect(decoded.tick).toBe(snap.tick)
    expect(decoded.lastProcessedSeq).toBe(snap.lastProcessedSeq)
    expect(decoded.entities).toHaveLength(snap.entities.length)

    for (let i = 0; i < snap.entities.length; i += 1) {
      const a = snap.entities[i]
      const b = decoded.entities[i]
      expect(a).toBeDefined()
      expect(b).toBeDefined()
      if (!a || !b) continue
      expect(b.id).toBe(a.id)
      expect(b.kind).toBe(a.kind)
      expect(Math.abs(b.x - a.x)).toBeLessThan(1e-3)
      expect(Math.abs(b.y - a.y)).toBeLessThan(1e-3)
      expect(Math.abs(b.angle - a.angle)).toBeLessThanOrEqual(0.002)
    }

    const decodedJson = jsonCodec.decodeSnapshot(jsonCodec.encodeSnapshot(snap))
    expect(decodedJson.entities).toHaveLength(snap.entities.length)

    expect(() => binaryCodec.decodeInput(new ArrayBuffer(3))).toThrow(
      RangeError,
    )
    expect(() => binaryCodec.decodeSnapshot(new ArrayBuffer(5))).toThrow(
      RangeError,
    )
  })

  it('RoomManager enforces room/player limits and auto-deletes empty non-persistent rooms', async () => {
    const manager = new RoomManager({ maxRooms: 2, maxPlayersPerRoom: 1 })
    const r1 = manager.create({ name: 'Alpha', persistent: false })
    manager.create({ name: 'Beta', persistent: true })

    expect(() => manager.create({ name: 'Gamma' })).toThrow(/Room limit/)

    const p1: RoomPlayer = {
      id: 'p1',
      shipId: asEntityId(1),
      name: 'One',
      codec: 'binary',
      socket: null,
      joinedAt: Date.now(),
    }
    const p2: RoomPlayer = {
      id: 'p2',
      shipId: asEntityId(2),
      name: 'Two',
      codec: 'binary',
      socket: null,
      joinedAt: Date.now(),
    }

    expect(r1.join(p1)).toBe(true)
    expect(r1.join(p2)).toBe(false)
    expect(manager.totalPlayers()).toBe(1)

    r1.leave('p1')
    expect(manager.get(r1.id)).toBeUndefined()
    await manager.closeAll()
  })

  it('Match steps on 30Hz timer, processes queued inputs in seq order, and tracks stats', () => {
    vi.useFakeTimers()
    const manager = new RoomManager({ maxRooms: 5, maxPlayersPerRoom: 4 })
    const room = manager.create({ name: 'Match Test', persistent: true })
    const broadcasts: number[] = []
    let latestAck = 0

    const match = new Match(room, {
      seed: 123,
      onTickBroadcast({ baseSnapshot, lastProcessedSeqByShip }) {
        broadcasts.push(baseSnapshot.tick)
        latestAck = lastProcessedSeqByShip.get(asEntityId(1)) ?? 0
      },
    })

    match.addPlayer(asEntityId(1))
    match.enqueueInput(asEntityId(1), {
      seq: asSeq(2),
      tick: asTick(2),
      turn: 1,
      thrust: true,
      fire: false,
      fireHoming: false,
    })
    match.enqueueInput(asEntityId(1), {
      seq: asSeq(1),
      tick: asTick(1),
      turn: -1,
      thrust: true,
      fire: true,
      fireHoming: false,
    })

    vi.advanceTimersByTime(110) // ~3 ticks at 30 Hz
    match.stop()

    expect(broadcasts.length).toBeGreaterThanOrEqual(3)
    expect(latestAck).toBe(2)

    const stats = match.getStats()
    expect(stats.roomId).toBe(room.id)
    expect(stats.totalTicks).toBe(broadcasts.length)
    expect(stats.running).toBe(false)
  })

  it('NetSimulator clamps config, executes immediately at 0ms, and delays when RTT > 0', () => {
    vi.useFakeTimers()
    const sim = new NetSimulator()
    sim.configure({ rttMs: 9999, jitterMs: 500, dropRate: 0.9 })
    expect(sim.getConfig()).toEqual({
      rttMs: 600,
      jitterMs: 200,
      dropRate: 0.3,
      droppedPackets: 0,
    })

    sim.configure({ rttMs: 0, jitterMs: 0, dropRate: 0 })
    const syncFn = vi.fn()
    sim.schedule(syncFn)
    expect(syncFn).toHaveBeenCalledTimes(1)

    sim.configure({ rttMs: 100, jitterMs: 0, dropRate: 0 })
    const delayedFn = vi.fn()
    sim.schedule(delayedFn)
    expect(delayedFn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(delayedFn).toHaveBeenCalledTimes(1)
  })

  it('RoomManager streams match events to NDJSON and readReplayEvents parses them back', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dogfight-log-'))
    try {
      const manager = new RoomManager({ logDir: tmpDir })
      const room = manager.create({ name: 'Test Arena', persistent: false })
      const player: RoomPlayer = {
        id: 'p1',
        shipId: asEntityId(1),
        name: 'Pilot',
        codec: 'binary',
        socket: null,
        joinedAt: Date.now(),
      }

      room.join(player)
      room.chat(player, 'gl hf')
      room.leave('p1')

      await manager.closeAll()

      const files = await readdir(tmpDir)
      expect(files).toHaveLength(1)
      const firstFile = files[0]
      expect(firstFile).toBeDefined()
      if (!firstFile) return

      const types: string[] = []
      for await (const evt of readReplayEvents(path.join(tmpDir, firstFile))) {
        if (
          typeof evt === 'object' &&
          evt !== null &&
          'type' in evt &&
          typeof evt.type === 'string'
        ) {
          types.push(evt.type)
        }
      }

      expect(types).toEqual(['room.created', 'join', 'chat', 'leave'])
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})
