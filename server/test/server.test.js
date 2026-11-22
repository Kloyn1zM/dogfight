import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MatchWorld,
  PROTOCOL_VERSION,
  TICK_DT,
  binaryCodec,
  createShipState,
  hashShipState,
  integrateShip,
  jsonCodec,
} from '@dogfight/shared'
import { validateClientMessage } from '../src/protocol.js'
import { RoomManager } from '../src/rooms.js'
import { readReplayEvents } from '../src/log/replay.js'

test('validateClientMessage accepts valid join, chat and input', () => {
  const joinRes = validateClientMessage(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'join',
      room: 'nebula-alpha',
      name: 'Ace',
    }),
  )
  assert.equal(joinRes.ok, true)
  assert.equal(joinRes.msg.name, 'Ace')

  const chatRes = validateClientMessage(
    JSON.stringify({ v: PROTOCOL_VERSION, type: 'chat', text: 'Привіт!' }),
  )
  assert.equal(chatRes.ok, true)

  const inputRes = validateClientMessage(
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
  assert.equal(inputRes.msg.turn, -1)
})

test('validateClientMessage rejects cheat turn, bad version and unknown type', () => {
  assert.equal(validateClientMessage('{broken').ok, false)
  assert.equal(
    validateClientMessage(
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
    validateClientMessage(JSON.stringify({ v: 99, type: 'chat', text: 'hi' }))
      .ok,
    false,
  )
  assert.equal(
    validateClientMessage(
      JSON.stringify({ v: PROTOCOL_VERSION, type: 'teleport' }),
    ).ok,
    false,
  )
})

test('shared simulation is deterministic across identical runs (1000 steps)', () => {
  function runOnce() {
    const ship = createShipState({ id: 1, x: 640, y: 360, angle: -Math.PI / 2 })
    for (let i = 0; i < 1000; i += 1) {
      const turn = i % 30 < 10 ? 1 : i % 30 < 20 ? -1 : 0
      const thrust = i % 3 !== 0
      integrateShip(ship, { turn, thrust }, TICK_DT)
    }
    return hashShipState(ship)
  }

  const h1 = runOnce()
  const h2 = runOnce()
  assert.equal(h1, h2)
})

test('binary DataView codec round-trips input and snapshot within quantization tolerance', () => {
  const input = {
    seq: 4242,
    tick: 9001,
    turn: -1,
    thrust: true,
    fire: false,
    fireHoming: true,
  }
  const decodedInput = binaryCodec.decodeInput(binaryCodec.encodeInput(input))
  assert.deepEqual(decodedInput, input)

  const world = new MatchWorld({ seed: 777, targetAsteroids: 4 })
  world.addShip(1)
  world.addShip(2)
  const inputs = new Map([
    [1, { turn: 1, thrust: true, fire: true, fireHoming: false }],
    [2, { turn: -1, thrust: true, fire: false, fireHoming: true }],
  ])
  for (let i = 0; i < 20; i += 1) {
    world.step(TICK_DT, inputs)
  }

  const snap = world.getSnapshot(19)
  const binBuf = binaryCodec.encodeSnapshot(snap)
  const decoded = binaryCodec.decodeSnapshot(binBuf)

  assert.equal(decoded.tick, snap.tick)
  assert.equal(decoded.lastProcessedSeq, snap.lastProcessedSeq)
  assert.equal(decoded.entities.length, snap.entities.length)

  for (let i = 0; i < snap.entities.length; i += 1) {
    const a = snap.entities[i]
    const b = decoded.entities[i]
    assert.equal(b.id, a.id)
    assert.equal(b.kind, a.kind)
    assert.ok(Math.abs(b.x - a.x) < 1e-3)
    assert.ok(Math.abs(b.y - a.y) < 1e-3)
    assert.ok(Math.abs(b.angle - a.angle) <= 0.002)
  }

  // Перевірка, що JSON-кодек теж робить round-trip
  const decodedJson = jsonCodec.decodeSnapshot(jsonCodec.encodeSnapshot(snap))
  assert.equal(decodedJson.entities.length, snap.entities.length)

  // Пошкоджені буфери кидають RangeError, не крешать процес
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
    const player = { id: 'p1', shipId: 1, name: 'Pilot', socket: null }

    room.join(player)
    room.chat(player, 'gl hf')
    room.leave('p1')

    await manager.closeAll()

    const files = await readdir(tmpDir)
    assert.equal(files.length, 1)

    const events = []
    for await (const evt of readReplayEvents(path.join(tmpDir, files[0]))) {
      events.push(evt)
    }

    assert.deepEqual(
      events.map((e) => e.type),
      ['room.created', 'join', 'chat', 'leave'],
    )
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})
