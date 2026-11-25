import {
  ENTITY_KIND,
  KIND_FROM_CODE,
  PROTOCOL_VERSION,
} from '../sim/constants.ts'
import { normalizeAngle } from '../sim/physics.ts'
import {
  asEntityId,
  asSeq,
  asTick,
  assertNever,
  type Codec,
  type EntityId,
  type InputCommand,
  type PickupEffect,
  type Seq,
  type Snapshot,
  type SnapshotEntity,
  type Tick,
} from '../types.ts'

/**
 * БІНАРНА СПЕЦИФІКАЦІЯ ПРОТОКОЛУ v2 (Little-Endian)
 * - INPUT (12 bytes):    [0] type=1, [1] v=2, [2..5] seq u32, [6..9] tick u32, [10] turn i8, [11] flags u8
 * - SNAPSHOT (16+N*26):  [0] type=2, [1] v=2, [2..5] tick u32, [6..9] ackSeq u32, [10..13] matchTimeMs u32, [14..15] count u16
 *   Entity (26 bytes):   id u16, kind u8, flags u8, x/y/vx/vy f32, angleQ i16 (1/1000 rad), metaA u16, metaB u16
 */

export const BIN_MSG_INPUT = 1
export const BIN_MSG_SNAPSHOT = 2
export const INPUT_BYTE_LENGTH = 12
export const SNAPSHOT_HEADER_BYTES = 16
export const ENTITY_BYTE_STRIDE = 26

const LE = true
const ANGLE_SCALE = 1000

function toDataView(input: unknown): DataView {
  if (input instanceof ArrayBuffer) {
    return new DataView(input)
  }
  if (ArrayBuffer.isView(input)) {
    return new DataView(input.buffer, input.byteOffset, input.byteLength)
  }
  throw new TypeError('Expected ArrayBuffer or ArrayBufferView')
}

export function quantizeAngle(angle: number): number {
  const norm = normalizeAngle(angle)
  const scaled = Math.round(norm * ANGLE_SCALE)
  return Math.max(-32768, Math.min(32767, scaled))
}

export function dequantizeAngle(angleQ: number): number {
  return angleQ / ANGLE_SCALE
}

export function encodeInputBinary(input: InputCommand): ArrayBuffer {
  const buf = new ArrayBuffer(INPUT_BYTE_LENGTH)
  const view = new DataView(buf)
  const flags =
    (input.thrust ? 1 : 0) | (input.fire ? 2 : 0) | (input.fireHoming ? 4 : 0)

  view.setUint8(0, BIN_MSG_INPUT)
  view.setUint8(1, PROTOCOL_VERSION)
  view.setUint32(2, input.seq >>> 0, LE)
  view.setUint32(6, input.tick >>> 0, LE)
  view.setInt8(10, input.turn)
  view.setUint8(11, flags)
  return buf
}

export function decodeInputBinary(raw: unknown): InputCommand {
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

  const seq = asSeq(view.getUint32(2, LE))
  const tick = asTick(view.getUint32(6, LE))
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

export function encodeSnapshotBinary(snapshot: Snapshot): ArrayBuffer {
  const entities = snapshot.entities
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
    let flags = 0
    let metaA = 0
    let metaB = 0

    switch (e.kind) {
      case 'ship':
        flags =
          (e.thrusting ? 1 : 0) |
          (e.shieldActive ? 2 : 0) |
          (e.rapidFireActive ? 4 : 0) |
          (e.alive ? 8 : 0)
        metaA = Math.max(0, Math.min(65535, Math.round(e.hp)))
        metaB = Math.max(0, Math.min(65535, Math.round(e.score)))
        break
      case 'bullet':
        flags = e.isHoming ? 1 : 0
        metaA = e.ownerId & 0xffff
        break
      case 'asteroid':
        flags = e.isHoming ? 1 : 0
        metaA = Math.round(e.radius) & 0xffff
        metaB = Math.max(0, Math.round(e.hp)) & 0xffff
        break
      case 'pickup':
        flags = e.effect === 'rapidFire' ? 1 : 0
        metaA = Math.round(e.radius) & 0xffff
        break
      default:
        assertNever(e)
    }

    view.setUint16(offset, e.id & 0xffff, LE)
    view.setUint8(offset + 2, kindCode)
    view.setUint8(offset + 3, flags)
    view.setFloat32(offset + 4, e.x, LE)
    view.setFloat32(offset + 8, e.y, LE)
    view.setFloat32(offset + 12, e.vx, LE)
    view.setFloat32(offset + 16, e.vy, LE)
    view.setInt16(offset + 20, quantizeAngle(e.angle), LE)
    view.setUint16(offset + 22, metaA, LE)
    view.setUint16(offset + 24, metaB, LE)
    offset += ENTITY_BYTE_STRIDE
  }

  return buf
}

export function decodeSnapshotBinary(raw: unknown): Snapshot {
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

  const tick = asTick(view.getUint32(2, LE))
  const lastProcessedSeq = asSeq(view.getUint32(6, LE))
  const matchTimeMs = view.getUint32(10, LE)
  const count = view.getUint16(14, LE)

  const expectedLength = SNAPSHOT_HEADER_BYTES + count * ENTITY_BYTE_STRIDE
  if (view.byteLength !== expectedLength) {
    throw new RangeError(
      `Invalid binary snapshot size: ${view.byteLength} (expected ${expectedLength})`,
    )
  }

  const entities: SnapshotEntity[] = []
  let offset = SNAPSHOT_HEADER_BYTES

  for (let i = 0; i < count; i += 1) {
    const id = asEntityId(view.getUint16(offset, LE))
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

    switch (kind) {
      case 'ship':
        entities.push({
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
        })
        break
      case 'bullet':
        entities.push({
          id,
          kind,
          x,
          y,
          vx,
          vy,
          angle,
          isHoming: (flags & 1) !== 0,
          ownerId: asEntityId(metaA),
        })
        break
      case 'asteroid':
        entities.push({
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
        })
        break
      case 'pickup':
        entities.push({
          id,
          kind,
          x,
          y,
          vx,
          vy,
          angle,
          effect: (flags & 1) !== 0 ? 'rapidFire' : 'shield',
          radius: metaA,
        })
        break
      default:
        assertNever(kind)
    }

    offset += ENTITY_BYTE_STRIDE
  }

  return { tick, lastProcessedSeq, matchTimeMs, entities }
}

interface MutableShipSlot {
  id: EntityId
  kind: 'ship'
  x: number
  y: number
  vx: number
  vy: number
  angle: number
  thrusting: boolean
  shieldActive: boolean
  rapidFireActive: boolean
  alive: boolean
  hp: number
  score: number
}

interface MutableBulletSlot {
  id: EntityId
  kind: 'bullet'
  x: number
  y: number
  vx: number
  vy: number
  angle: number
  isHoming: boolean
  ownerId: EntityId
}

interface MutableAsteroidSlot {
  id: EntityId
  kind: 'asteroid'
  x: number
  y: number
  vx: number
  vy: number
  angle: number
  isHoming: boolean
  radius: number
  hp: number
}

interface MutablePickupSlot {
  id: EntityId
  kind: 'pickup'
  x: number
  y: number
  vx: number
  vy: number
  angle: number
  effect: PickupEffect
  radius: number
}

/**
 * Перевикористовуваний буфер декодування бінарного снапшота (zero-allocation у steady-state).
 * Прибирає основне джерело GC-тиску на клієнті, виявлене Chrome Allocation Profiler.
 */
export interface ReusableSnapshotBuffer {
  tick: Tick
  lastProcessedSeq: Seq
  matchTimeMs: number
  readonly entities: SnapshotEntity[]
  readonly ships: MutableShipSlot[]
  readonly bullets: MutableBulletSlot[]
  readonly asteroids: MutableAsteroidSlot[]
  readonly pickups: MutablePickupSlot[]
}

export function createReusableSnapshotBuffer(): ReusableSnapshotBuffer {
  return {
    tick: asTick(0),
    lastProcessedSeq: asSeq(0),
    matchTimeMs: 0,
    entities: [],
    ships: [],
    bullets: [],
    asteroids: [],
    pickups: [],
  }
}

export function decodeSnapshotBinaryInto(
  raw: unknown,
  out: ReusableSnapshotBuffer,
): Snapshot {
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

  const tick = asTick(view.getUint32(2, LE))
  const lastProcessedSeq = asSeq(view.getUint32(6, LE))
  const matchTimeMs = view.getUint32(10, LE)
  const count = view.getUint16(14, LE)

  const expectedLength = SNAPSHOT_HEADER_BYTES + count * ENTITY_BYTE_STRIDE
  if (view.byteLength !== expectedLength) {
    throw new RangeError(
      `Invalid binary snapshot size: ${view.byteLength} (expected ${expectedLength})`,
    )
  }

  out.tick = tick
  out.lastProcessedSeq = lastProcessedSeq
  out.matchTimeMs = matchTimeMs
  out.entities.length = 0

  let shipIdx = 0
  let bulletIdx = 0
  let astIdx = 0
  let pickupIdx = 0
  let offset = SNAPSHOT_HEADER_BYTES

  for (let i = 0; i < count; i += 1) {
    const id = asEntityId(view.getUint16(offset, LE))
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

    switch (kind) {
      case 'ship': {
        let slot = out.ships[shipIdx]
        if (!slot) {
          slot = {
            id,
            kind: 'ship',
            x,
            y,
            vx,
            vy,
            angle,
            thrusting: false,
            shieldActive: false,
            rapidFireActive: false,
            alive: false,
            hp: 0,
            score: 0,
          }
          out.ships.push(slot)
        }
        shipIdx += 1
        slot.id = id
        slot.x = x
        slot.y = y
        slot.vx = vx
        slot.vy = vy
        slot.angle = angle
        slot.thrusting = (flags & 1) !== 0
        slot.shieldActive = (flags & 2) !== 0
        slot.rapidFireActive = (flags & 4) !== 0
        slot.alive = (flags & 8) !== 0
        slot.hp = metaA
        slot.score = metaB
        out.entities.push(slot)
        break
      }
      case 'bullet': {
        let slot = out.bullets[bulletIdx]
        if (!slot) {
          slot = {
            id,
            kind: 'bullet',
            x,
            y,
            vx,
            vy,
            angle,
            isHoming: false,
            ownerId: asEntityId(0),
          }
          out.bullets.push(slot)
        }
        bulletIdx += 1
        slot.id = id
        slot.x = x
        slot.y = y
        slot.vx = vx
        slot.vy = vy
        slot.angle = angle
        slot.isHoming = (flags & 1) !== 0
        slot.ownerId = asEntityId(metaA)
        out.entities.push(slot)
        break
      }
      case 'asteroid': {
        let slot = out.asteroids[astIdx]
        if (!slot) {
          slot = {
            id,
            kind: 'asteroid',
            x,
            y,
            vx,
            vy,
            angle,
            isHoming: false,
            radius: 0,
            hp: 0,
          }
          out.asteroids.push(slot)
        }
        astIdx += 1
        slot.id = id
        slot.x = x
        slot.y = y
        slot.vx = vx
        slot.vy = vy
        slot.angle = angle
        slot.isHoming = (flags & 1) !== 0
        slot.radius = metaA
        slot.hp = metaB
        out.entities.push(slot)
        break
      }
      case 'pickup': {
        let slot = out.pickups[pickupIdx]
        if (!slot) {
          slot = {
            id,
            kind: 'pickup',
            x,
            y,
            vx,
            vy,
            angle,
            effect: 'shield',
            radius: 0,
          }
          out.pickups.push(slot)
        }
        pickupIdx += 1
        slot.id = id
        slot.x = x
        slot.y = y
        slot.vx = vx
        slot.vy = vy
        slot.angle = angle
        slot.effect = (flags & 1) !== 0 ? 'rapidFire' : 'shield'
        slot.radius = metaA
        out.entities.push(slot)
        break
      }
      default:
        assertNever(kind)
    }

    offset += ENTITY_BYTE_STRIDE
  }

  return out
}

export const binaryCodec: Codec = {
  name: 'binary',
  isBinary: true,
  encodeInput: encodeInputBinary,
  decodeInput: decodeInputBinary,
  encodeSnapshot: encodeSnapshotBinary,
  decodeSnapshot: decodeSnapshotBinary,
}
