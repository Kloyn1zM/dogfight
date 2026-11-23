import test from 'node:test'
import assert from 'node:assert/strict'
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
import { RoomManager, type RoomPlayer } from '../src/rooms.ts'
import { readReplayEvents } from '../src/log/replay.ts'

test('loadConfig validates env via Zod and rejects invalid PORT', () => {
  const defaults = loadConfig({})
  assert.equal(defaults.port, 3000)
  assert.equal(defaults.maxRooms, 20)

  assert.throws(
    () => loadConfig({ PORT: 'not-a-number' }),
    /Invalid server config/,
  )
  assert.throws(() => loadConfig({ PORT: '99999' }), /Invalid server config/)
})

test('parseClientMessage (Zod) accepts valid join, chat and input', () => {
  const joinRes = parseClientMessage(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'join',
      room: 'nebula-alpha',
      name: 'Ace',
    }),
  )
  assert.equal(joinRes.ok, true)
  if (joinRes.ok && joinRes.value.type === 'join') {
    assert.equal(joinRes.value.name, 'Ace')
    assert.equal(joinRes.value.codec, 'binary')
  }

  const chatRes = parseClientMessage(
    JSON.stringify({ v: PROTOCOL_VERSION, type: 'chat', text: 'Привіт!' }),
  )
  assert.equal(chatRes.ok, true)

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
  assert.equal(inputRes.ok, true)
  if (inputRes.ok && inputRes.value.type === 'input') {
    assert.equal(inputRes.value.turn, -1)
  }
})

test('parseClientMessage rejects cheat turn, bad version and unknown type', () => {
  assert.equal(parseClientMessage('{broken').ok, false)
  assert.equal(
    parseClientMessage(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'input',
        seq: 1,
        turn: 1000,
      }),
    ).ok,
    false,
  )
  assert.equal(
    parseClientMessage(JSON.stringify({ v: 99, type: 'chat', text: 'hi' })).ok,
    false,
  )
  assert.equal(
    parseClientMessage(
      JSON.stringify({ v: PROTOCOL_VERSION, type: 'teleport' }),
    ).ok,
    false,
  )
})

test('shared simulation stays bit-identical after TS migration (hash babcfb7b)', () => {
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
  assert.equal(hashShipState(ship), 'babcfb7b')
})

test('binary DataView codec round-trips input and snapshot within tolerance', () => {
  const input: InputCommand = {
    seq: asSeq(4242),
    tick: asTick(9001),
    turn: -1,
    thrust: true,
    fire: false,
    fireHoming: true,
  }
  const decodedInput = binaryCodec.decodeInput(binaryCodec.encodeInput(input))
  assert.deepEqual(decodedInput, input)

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

  assert.equal(decoded.tick, snap.tick)
  assert.equal(decoded.lastProcessedSeq, snap.lastProcessedSeq)
  assert.equal(decoded.entities.length, snap.entities.length)

  for (let i = 0; i < snap.entities.length; i += 1) {
    const a = snap.entities[i]
    const b = decoded.entities[i]
    assert.ok(a && b)
    assert.equal(b.id, a.id)
    assert.equal(b.kind, a.kind)
    assert.ok(Math.abs(b.x - a.x) < 1e-3)
    assert.ok(Math.abs(b.y - a.y) < 1e-3)
    assert.ok(Math.abs(b.angle - a.angle) <= 0.002)
  }

  const decodedJson = jsonCodec.decodeSnapshot(jsonCodec.encodeSnapshot(snap))
  assert.equal(decodedJson.entities.length, snap.entities.length)

  assert.throws(() => binaryCodec.decodeInput(new ArrayBuffer(3)), RangeError)
  assert.throws(
    () => binaryCodec.decodeSnapshot(new ArrayBuffer(5)),
    RangeError,
  )
})

test('RoomManager streams match events to NDJSON and readReplayEvents parses them back', async () => {
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
    assert.equal(files.length, 1)
    const firstFile = files[0]
    assert.ok(firstFile)

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

    assert.deepEqual(types, ['room.created', 'join', 'chat', 'leave'])
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})
