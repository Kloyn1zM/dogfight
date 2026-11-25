import { describe, expect, it, vi } from 'vitest'
import {
  BIN_MSG_INPUT,
  BIN_MSG_SNAPSHOT,
  ENTITY_BYTE_STRIDE,
  INPUT_BYTE_LENGTH,
  PROTOCOL_VERSION,
  SNAPSHOT_HEADER_BYTES,
  TypedBus,
  asEntityId,
  asSeq,
  asTick,
  binaryCodec,
  createPrng,
  encodeJsonMessage,
  jsonCodec,
  parseServerMessage,
  type InputCommand,
  type Snapshot,
} from '@dogfight/shared'

describe('TypedBus, PRNG, jsonCodec, binaryCodec edge cases, and server messages', () => {
  it('TypedBus dispatches events, supports unsubscribe, once, and clear', () => {
    type Events = { ping: { n: number }; done: boolean }
    const bus = new TypedBus<Events>()
    const seen: number[] = []

    const off = bus.on('ping', ({ n }) => seen.push(n))
    const onceFn = vi.fn()
    bus.once('ping', onceFn)

    bus.emit('ping', { n: 1 })
    bus.emit('ping', { n: 2 })
    expect(seen).toEqual([1, 2])
    expect(onceFn).toHaveBeenCalledTimes(1)

    off()
    bus.emit('ping', { n: 3 })
    expect(seen).toEqual([1, 2])

    const doneFn = vi.fn()
    bus.on('done', doneFn)
    bus.clear()
    bus.emit('done', true)
    expect(doneFn).not.toHaveBeenCalled()
  })

  it('createPrng produces identical deterministic sequence in [0, 1)', () => {
    const a = createPrng(999)
    const b = createPrng(999)
    for (let i = 0; i < 50; i += 1) {
      const va = a.next()
      const vb = b.next()
      expect(va).toBe(vb)
      expect(va).toBeGreaterThanOrEqual(0)
      expect(va).toBeLessThan(1)
    }
    expect(a.getState()).toBe(b.getState())
  })

  it('jsonCodec round-trips input and snapshot and rejects invalid payloads', () => {
    const inp: InputCommand = {
      seq: asSeq(5),
      tick: asTick(12),
      turn: 1,
      thrust: true,
      fire: false,
      fireHoming: true,
    }
    const rawInp = jsonCodec.encodeInput(inp)
    expect(jsonCodec.decodeInput(rawInp)).toEqual(inp)

    const snap: Snapshot = {
      tick: asTick(20),
      lastProcessedSeq: asSeq(5),
      matchTimeMs: 667,
      entities: [
        {
          id: asEntityId(1),
          kind: 'ship',
          x: 100,
          y: 200,
          vx: 10,
          vy: -5,
          angle: 0.5,
          thrusting: true,
          shieldActive: false,
          rapidFireActive: true,
          alive: true,
          hp: 100,
          score: 50,
        },
      ],
    }
    const rawSnap = jsonCodec.encodeSnapshot(snap)
    expect(jsonCodec.decodeSnapshot(rawSnap)).toEqual(snap)

    expect(() => jsonCodec.decodeInput({ type: 'wrong' })).toThrow(RangeError)
    expect(() => jsonCodec.decodeSnapshot({ type: 'wrong' })).toThrow(RangeError)
  })

  it('binaryCodec rejects wrong types, versions, turn values, kind codes, and NaN coordinates', () => {
    expect(() => binaryCodec.decodeInput('not-a-buffer')).toThrow(TypeError)
    expect(() => binaryCodec.decodeSnapshot(123)).toThrow(TypeError)

    const badInput = new ArrayBuffer(INPUT_BYTE_LENGTH)
    const iv = new DataView(badInput)
    iv.setUint8(0, 99)
    iv.setUint8(1, PROTOCOL_VERSION)
    expect(() => binaryCodec.decodeInput(badInput)).toThrow(RangeError)

    iv.setUint8(0, BIN_MSG_INPUT)
    iv.setUint8(1, 99)
    expect(() => binaryCodec.decodeInput(badInput)).toThrow(RangeError)

    iv.setUint8(1, PROTOCOL_VERSION)
    iv.setInt8(10, 2)
    expect(() => binaryCodec.decodeInput(badInput)).toThrow(RangeError)

    const badSnap = new ArrayBuffer(SNAPSHOT_HEADER_BYTES + ENTITY_BYTE_STRIDE)
    const sv = new DataView(badSnap)
    sv.setUint8(0, 99)
    sv.setUint8(1, PROTOCOL_VERSION)
    sv.setUint16(14, 1, true)
    expect(() => binaryCodec.decodeSnapshot(badSnap)).toThrow(RangeError)

    sv.setUint8(0, BIN_MSG_SNAPSHOT)
    sv.setUint8(1, 99)
    expect(() => binaryCodec.decodeSnapshot(badSnap)).toThrow(RangeError)

    sv.setUint8(1, PROTOCOL_VERSION)
    sv.setUint8(SNAPSHOT_HEADER_BYTES + 2, 255)
    expect(() => binaryCodec.decodeSnapshot(badSnap)).toThrow(RangeError)

    sv.setUint8(SNAPSHOT_HEADER_BYTES + 2, 1)
    sv.setFloat32(SNAPSHOT_HEADER_BYTES + 4, Number.NaN, true)
    expect(() => binaryCodec.decodeSnapshot(badSnap)).toThrow(RangeError)
  })

  it('encodeJsonMessage stamps PROTOCOL_VERSION and parseServerMessage validates messages', () => {
    const encoded = encodeJsonMessage({ type: 'pong', t: 1234 })
    const parsed = parseServerMessage(encoded)
    expect(parsed.ok).toBe(true)
    if (parsed.ok && parsed.value.type === 'pong') {
      expect(parsed.value.t).toBe(1234)
    }

    expect(parseServerMessage('{bad-json').ok).toBe(false)
    expect(
      parseServerMessage(JSON.stringify({ v: PROTOCOL_VERSION, type: 'nope' }))
        .ok,
    ).toBe(false)
  })
})
