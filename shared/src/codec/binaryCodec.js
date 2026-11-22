import {
  ENTITY_KIND,
  KIND_FROM_CODE,
  PROTOCOL_VERSION,
} from '../sim/constants.js'
import { normalizeAngle } from '../sim/physics.js'

/**
 * БІНАРНА СПЕЦИФІКАЦІЯ ПРОТОКОЛУ v2 (Little-Endian скрізь!)
 *
 * 1) INPUT (Client -> Server), фіксовано 12 байтів:
 *    [0]     Uint8   msgType = 1 (BIN_MSG_INPUT)
 *    [1]     Uint8   version = 2 (PROTOCOL_VERSION)
 *    [2..5]  Uint32  seq
 *    [6..9]  Uint32  tick
 *    [10]    Int8    turn (-1 | 0 | 1)
 *    [11]    Uint8   flags (bit0=thrust, bit1=fire, bit2=fireHoming)
 *
 * 2) SNAPSHOT (Server -> Client), заголовок 16 байтів + N * 26 байтів:
 *    Header (16 bytes):
 *    [0]      Uint8   msgType = 2 (BIN_MSG_SNAPSHOT)
 *    [1]      Uint8   version = 2 (PROTOCOL_VERSION)
 *    [2..5]   Uint32  tick
 *    [6..9]   Uint32  lastProcessedSeq
 *    [10..13] Uint32  matchTimeMs
 *    [14..15] Uint16  entityCount (N)
 *
 *    Entity record (26 bytes each):
 *    [+0..+1]   Uint16  id
 *    [+2]       Uint8   kind (1=ship, 2=bullet, 3=asteroid, 4=pickup)
 *    [+3]       Uint8   flags:
 *                       ship: bit0=thrusting, bit1=shieldActive, bit2=rapidFireActive, bit3=alive
 *                       bullet/asteroid: bit0=isHoming
 *                       pickup: bit0=(effect === 'rapidFire')
 *    [+4..+7]   Float32 x
 *    [+8..+11]  Float32 y
 *    [+12..+15] Float32 vx
 *    [+16..+19] Float32 vy
 *    [+20..+21] Int16   angleQ (квантизований кут у 1/1000 радіана, точність ~0.057°)
 *    [+22..+23] Uint16  metaA (ship: hp | bullet: ownerId | asteroid/pickup: radius)
 *    [+24..+25] Uint16  metaB (ship: score | asteroid: hp | інше: 0)
 */

export const BIN_MSG_INPUT = 1
export const BIN_MSG_SNAPSHOT = 2
export const INPUT_BYTE_LENGTH = 12
export const SNAPSHOT_HEADER_BYTES = 16
export const ENTITY_BYTE_STRIDE = 26

const LE = true
const ANGLE_SCALE = 1000

function toDataView(input) {
  if (input instanceof ArrayBuffer) {
    return new DataView(input)
  }
  if (ArrayBuffer.isView(input)) {
    return new DataView(input.buffer, input.byteOffset, input.byteLength)
  }
  throw new TypeError('Expected ArrayBuffer or ArrayBufferView')
}

export function quantizeAngle(angle) {
  const norm = normalizeAngle(angle)
  const scaled = Math.round(norm * ANGLE_SCALE)
  return Math.max(-32768, Math.min(32767, scaled))
}

export function dequantizeAngle(angleQ) {
  return angleQ / ANGLE_SCALE
}

export function encodeInputBinary(input) {
  const buf = new ArrayBuffer(INPUT_BYTE_LENGTH)
  const view = new DataView(buf)
  const turn = input.turn > 0 ? 1 : input.turn < 0 ? -1 : 0
  const flags =
    (input.thrust ? 1 : 0) | (input.fire ? 2 : 0) | (input.fireHoming ? 4 : 0)

  view.setUint8(0, BIN_MSG_INPUT)
  view.setUint8(1, PROTOCOL_VERSION)
  view.setUint32(2, input.seq >>> 0, LE)
  view.setUint32(6, input.tick >>> 0, LE)
  view.setInt8(10, turn)
  view.setUint8(11, flags)
  return buf
}

export function decodeInputBinary(raw) {
  const view = toDataView(raw)
  if (view.byteLength !== INPUT_BYTE_LENGTH) {
    throw new RangeError(
      `Invalid input packet length: ${view.byteLength} (expected ${INPUT_BYTE_LENGTH})`,
    )
  }
  const msgType = view.getUint8(0)
  const version = view.getUint8(1)
  if (msgType !== BIN_MSG_INPUT) {
    throw new RangeError(`Unexpected binary message type: ${msgType}`)
  }
  if (version !== PROTOCOL_VERSION) {
    throw new RangeError(`Unsupported binary protocol version: ${version}`)
  }

  const seq = view.getUint32(2, LE)
  const tick = view.getUint32(6, LE)
  const turn = view.getInt8(10)
  if (turn !== -1 && turn !== 0 && turn !== 1) {
    throw new RangeError(`Invalid turn value: ${turn}`)
  }
  const flags = view.getUint8(11)

  return {
    seq,
    tick,
    turn,
    thrust: (flags & 1) !== 0,
    fire: (flags & 2) !== 0,
    fireHoming: (flags & 4) !== 0,
  }
}

export function encodeSnapshotBinary(snapshot) {
  const entities = snapshot.entities || []
  const count = entities.length
  const buf = new ArrayBuffer(
    SNAPSHOT_HEADER_BYTES + count * ENTITY_BYTE_STRIDE,
  )
  const view = new DataView(buf)

  view.setUint8(0, BIN_MSG_SNAPSHOT)
  view.setUint8(1, PROTOCOL_VERSION)
  view.setUint32(2, snapshot.tick >>> 0, LE)
  view.setUint32(6, snapshot.lastProcessedSeq >>> 0, LE)
  view.setUint32(10, snapshot.matchTimeMs >>> 0, LE)
  view.setUint16(14, count, LE)

  let offset = SNAPSHOT_HEADER_BYTES
  for (const e of entities) {
    const kindCode = ENTITY_KIND[e.kind]
    if (!kindCode) {
      throw new RangeError(`Unknown entity kind: ${String(e.kind)}`)
    }

    let flags = 0
    let metaA = 0
    let metaB = 0

    if (e.kind === 'ship') {
      flags =
        (e.thrusting ? 1 : 0) |
        (e.shieldActive ? 2 : 0) |
        (e.rapidFireActive ? 4 : 0) |
        (e.alive ? 8 : 0)
      metaA = Math.max(0, Math.min(65535, Math.round(e.hp || 0)))
      metaB = Math.max(0, Math.min(65535, Math.round(e.score || 0)))
    } else if (e.kind === 'bullet') {
      flags = e.isHoming ? 1 : 0
      metaA = e.ownerId & 0xffff
    } else if (e.kind === 'asteroid') {
      flags = e.isHoming ? 1 : 0
      metaA = Math.round(e.radius || 0) & 0xffff
      metaB = Math.max(0, Math.round(e.hp || 0)) & 0xffff
    } else if (e.kind === 'pickup') {
      flags = e.effect === 'rapidFire' ? 1 : 0
      metaA = Math.round(e.radius || 0) & 0xffff
    }

    view.setUint16(offset, e.id & 0xffff, LE)
    view.setUint8(offset + 2, kindCode)
    view.setUint8(offset + 3, flags)
    view.setFloat32(offset + 4, e.x, LE)
    view.setFloat32(offset + 8, e.y, LE)
    view.setFloat32(offset + 12, e.vx || 0, LE)
    view.setFloat32(offset + 16, e.vy || 0, LE)
    view.setInt16(offset + 20, quantizeAngle(e.angle || 0), LE)
    view.setUint16(offset + 22, metaA, LE)
    view.setUint16(offset + 24, metaB, LE)
    offset += ENTITY_BYTE_STRIDE
  }

  return buf
}

export function decodeSnapshotBinary(raw) {
  const view = toDataView(raw)
  if (view.byteLength < SNAPSHOT_HEADER_BYTES) {
    throw new RangeError('Binary snapshot shorter than header')
  }

  const msgType = view.getUint8(0)
  const version = view.getUint8(1)
  if (msgType !== BIN_MSG_SNAPSHOT) {
    throw new RangeError(`Unexpected binary snapshot type: ${msgType}`)
  }
  if (version !== PROTOCOL_VERSION) {
    throw new RangeError(`Unsupported binary protocol version: ${version}`)
  }

  const tick = view.getUint32(2, LE)
  const lastProcessedSeq = view.getUint32(6, LE)
  const matchTimeMs = view.getUint32(10, LE)
  const count = view.getUint16(14, LE)

  const expectedLength = SNAPSHOT_HEADER_BYTES + count * ENTITY_BYTE_STRIDE
  if (view.byteLength !== expectedLength) {
    throw new RangeError(
      `Invalid binary snapshot size: ${view.byteLength} (expected ${expectedLength})`,
    )
  }

  const entities = new Array(count)
  let offset = SNAPSHOT_HEADER_BYTES

  for (let i = 0; i < count; i += 1) {
    const id = view.getUint16(offset, LE)
    const kindCode = view.getUint8(offset + 2)
    const kind = KIND_FROM_CODE[kindCode]
    if (!kind) {
      throw new RangeError(`Unknown entity kind code: ${kindCode}`)
    }

    const flags = view.getUint8(offset + 3)
    const x = view.getFloat32(offset + 4, LE)
    const y = view.getFloat32(offset + 8, LE)
    const vx = view.getFloat32(offset + 12, LE)
    const vy = view.getFloat32(offset + 16, LE)
    const angle = dequantizeAngle(view.getInt16(offset + 20, LE))
    const metaA = view.getUint16(offset + 22, LE)
    const metaB = view.getUint16(offset + 24, LE)

    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(vx) ||
      !Number.isFinite(vy)
    ) {
      throw new RangeError('Non-finite coordinates in snapshot')
    }

    if (kind === 'ship') {
      entities[i] = {
        id,
        kind,
        x,
        y,
        vx,
        vy,
        angle,
        thrusting: (flags & 1) !== 0,
        shieldActive: (flags & 2) !== 0,
        rapidFireActive: (flags & 4) !== 0,
        alive: (flags & 8) !== 0,
        hp: metaA,
        score: metaB,
      }
    } else if (kind === 'bullet') {
      entities[i] = {
        id,
        kind,
        x,
        y,
        vx,
        vy,
        angle,
        isHoming: (flags & 1) !== 0,
        ownerId: metaA,
      }
    } else if (kind === 'asteroid') {
      entities[i] = {
        id,
        kind,
        x,
        y,
        vx,
        vy,
        angle,
        isHoming: (flags & 1) !== 0,
        radius: metaA,
        hp: metaB,
      }
    } else {
      entities[i] = {
        id,
        kind,
        x,
        y,
        vx,
        vy,
        angle,
        effect: (flags & 1) !== 0 ? 'rapidFire' : 'shield',
        radius: metaA,
      }
    }

    offset += ENTITY_BYTE_STRIDE
  }

  return { tick, lastProcessedSeq, matchTimeMs, entities }
}

export const binaryCodec = {
  name: 'binary',
  isBinary: true,
  encodeInput: encodeInputBinary,
  decodeInput: decodeInputBinary,
  encodeSnapshot: encodeSnapshotBinary,
  decodeSnapshot: decodeSnapshotBinary,
}
