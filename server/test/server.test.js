import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PROTOCOL_VERSION, validateClientMessage } from '../src/protocol.js'
import { RoomManager } from '../src/rooms.js'
import { readReplayEvents } from '../src/log/replay.js'

test('validateClientMessage accepts valid join and chat', () => {
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
  assert.equal(chatRes.msg.text, 'Привіт!')
})

test('validateClientMessage rejects bad version, unknown type and invalid JSON', () => {
  assert.equal(validateClientMessage('{broken').ok, false)
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

test('RoomManager streams match events to NDJSON and readReplayEvents parses them back', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dogfight-log-'))
  try {
    const manager = new RoomManager({ logDir: tmpDir })
    const room = manager.create({ name: 'Test Arena', persistent: false })
    const player = { id: 'p1', name: 'Pilot', socket: null }

    room.join(player)
    room.chat(player, 'gl hf')
    room.leave('p1')

    await manager.closeAll()

    const { readdir } = await import('node:fs/promises')
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
