import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  ENTITY_BYTE_STRIDE,
  INPUT_BYTE_LENGTH,
  MAX_SPEED,
  PROTOCOL_VERSION,
  SNAPSHOT_HEADER_BYTES,
  TICK_DT,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  asEntityId,
  asSeq,
  asTick,
  binaryCodec,
  createShipState,
  decodeInputBinary,
  decodeSnapshotBinary,
  encodeInputBinary,
  encodeSnapshotBinary,
  integrateShip,
  parseClientMessage,
  shortestAngleDiff,
  type InputCommand,
  type Snapshot,
  type SnapshotEntity,
  type TurnDirection,
} from '@dogfight/shared'

const turnArb: fc.Arbitrary<TurnDirection> = fc.constantFrom(-1, 0, 1)

const finiteCoordArb = (max: number) =>
  fc.float({ min: 0, max, noNaN: true, noDefaultInfinity: true })

const finiteVelArb = fc.float({
  min: -1000,
  max: 1000,
  noNaN: true,
  noDefaultInfinity: true,
})

const angleArb = fc.double({
  min: -Math.PI * 4,
  max: Math.PI * 4,
  noNaN: true,
  noDefaultInfinity: true,
})

const inputCommandArb: fc.Arbitrary<InputCommand> = fc.record({
  seq: fc.integer({ min: 0, max: 0xffffffff }).map(asSeq),
  tick: fc.integer({ min: 0, max: 0xffffffff }).map(asTick),
  turn: turnArb,
  thrust: fc.boolean(),
  fire: fc.boolean(),
  fireHoming: fc.boolean(),
})

const shipEntityArb: fc.Arbitrary<SnapshotEntity> = fc.record({
  id: fc.integer({ min: 0, max: 65535 }).map(asEntityId),
  kind: fc.constant('ship' as const),
  x: finiteCoordArb(WORLD_WIDTH),
  y: finiteCoordArb(WORLD_HEIGHT),
  vx: finiteVelArb,
  vy: finiteVelArb,
  angle: angleArb,
  thrusting: fc.boolean(),
  shieldActive: fc.boolean(),
  rapidFireActive: fc.boolean(),
  alive: fc.boolean(),
  hp: fc.integer({ min: 0, max: 65535 }),
  score: fc.integer({ min: 0, max: 65535 }),
})

const bulletEntityArb: fc.Arbitrary<SnapshotEntity> = fc.record({
  id: fc.integer({ min: 0, max: 65535 }).map(asEntityId),
  kind: fc.constant('bullet' as const),
  x: finiteCoordArb(WORLD_WIDTH),
  y: finiteCoordArb(WORLD_HEIGHT),
  vx: finiteVelArb,
  vy: finiteVelArb,
  angle: angleArb,
  isHoming: fc.boolean(),
  ownerId: fc.integer({ min: 0, max: 65535 }).map(asEntityId),
})

const asteroidEntityArb: fc.Arbitrary<SnapshotEntity> = fc.record({
  id: fc.integer({ min: 0, max: 65535 }).map(asEntityId),
  kind: fc.constant('asteroid' as const),
  x: finiteCoordArb(WORLD_WIDTH),
  y: finiteCoordArb(WORLD_HEIGHT),
  vx: finiteVelArb,
  vy: finiteVelArb,
  angle: angleArb,
  isHoming: fc.boolean(),
  radius: fc.integer({ min: 1, max: 200 }),
  hp: fc.integer({ min: 0, max: 65535 }),
})

const pickupEntityArb: fc.Arbitrary<SnapshotEntity> = fc.record({
  id: fc.integer({ min: 0, max: 65535 }).map(asEntityId),
  kind: fc.constant('pickup' as const),
  x: finiteCoordArb(WORLD_WIDTH),
  y: finiteCoordArb(WORLD_HEIGHT),
  vx: finiteVelArb,
  vy: finiteVelArb,
  angle: angleArb,
  effect: fc.constantFrom('shield' as const, 'rapidFire' as const),
  radius: fc.integer({ min: 1, max: 100 }),
})

const snapshotArb: fc.Arbitrary<Snapshot> = fc.record({
  tick: fc.integer({ min: 0, max: 0xffffffff }).map(asTick),
  lastProcessedSeq: fc.integer({ min: 0, max: 0xffffffff }).map(asSeq),
  matchTimeMs: fc.integer({ min: 0, max: 0xffffffff }),
  entities: fc.array(
    fc.oneof(shipEntityArb, bulletEntityArb, asteroidEntityArb, pickupEntityArb),
    { minLength: 0, maxLength: 50 },
  ),
})

describe('property-based invariants (fast-check)', () => {
  it('1. binaryCodec round-trips any InputCommand losslessly', () => {
    fc.assert(
      fc.property(inputCommandArb, (input) => {
        const buf = encodeInputBinary(input)
        const decoded = decodeInputBinary(buf)
        expect(decoded).toEqual(input)
      }),
      { numRuns: 200 },
    )
  })

  it('2. binaryCodec round-trips any Snapshot within Float32 & Int16 angle quantization', () => {
    fc.assert(
      fc.property(snapshotArb, (snap) => {
        const buf = encodeSnapshotBinary(snap)
        const decoded = decodeSnapshotBinary(buf)

        expect(decoded.tick).toBe(snap.tick)
        expect(decoded.lastProcessedSeq).toBe(snap.lastProcessedSeq)
        expect(decoded.matchTimeMs).toBe(snap.matchTimeMs)
        expect(decoded.entities).toHaveLength(snap.entities.length)

        for (let i = 0; i < snap.entities.length; i += 1) {
          const orig = snap.entities[i]
          const dec = decoded.entities[i]
          expect(orig).toBeDefined()
          expect(dec).toBeDefined()
          if (!orig || !dec) continue

          expect(dec.id).toBe(orig.id)
          expect(dec.kind).toBe(orig.kind)
          expect(Math.abs(dec.x - orig.x)).toBeLessThan(1e-3)
          expect(Math.abs(dec.y - orig.y)).toBeLessThan(1e-3)
          expect(Math.abs(dec.vx - orig.vx)).toBeLessThan(1e-3)
          expect(Math.abs(dec.vy - orig.vy)).toBeLessThan(1e-3)
          expect(
            Math.abs(shortestAngleDiff(orig.angle, dec.angle)),
          ).toBeLessThanOrEqual(0.0015)

          if (orig.kind === 'ship' && dec.kind === 'ship') {
            expect(dec.thrusting).toBe(orig.thrusting)
            expect(dec.shieldActive).toBe(orig.shieldActive)
            expect(dec.rapidFireActive).toBe(orig.rapidFireActive)
            expect(dec.alive).toBe(orig.alive)
            expect(dec.hp).toBe(orig.hp)
            expect(dec.score).toBe(orig.score)
          } else if (orig.kind === 'bullet' && dec.kind === 'bullet') {
            expect(dec.isHoming).toBe(orig.isHoming)
            expect(dec.ownerId).toBe(orig.ownerId)
          } else if (orig.kind === 'asteroid' && dec.kind === 'asteroid') {
            expect(dec.isHoming).toBe(orig.isHoming)
            expect(dec.radius).toBe(orig.radius)
            expect(dec.hp).toBe(orig.hp)
          } else if (orig.kind === 'pickup' && dec.kind === 'pickup') {
            expect(dec.effect).toBe(orig.effect)
            expect(dec.radius).toBe(orig.radius)
          }
        }
      }),
      { numRuns: 150 },
    )
  })

  it('3. encoded binary frame byte lengths strictly match protocol specification', () => {
    fc.assert(
      fc.property(inputCommandArb, snapshotArb, (input, snap) => {
        const inputBuf = encodeInputBinary(input)
        expect(inputBuf.byteLength).toBe(INPUT_BYTE_LENGTH)

        const snapBuf = encodeSnapshotBinary(snap)
        expect(snapBuf.byteLength).toBe(
          SNAPSHOT_HEADER_BYTES + snap.entities.length * ENTITY_BYTE_STRIDE,
        )
      }),
      { numRuns: 150 },
    )
  })

  it('4. binary decoders withstand arbitrary corrupted buffers without crashing', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 512 }), (bytes) => {
        for (const decode of [
          binaryCodec.decodeInput,
          binaryCodec.decodeSnapshot,
        ]) {
          try {
            const res = decode(bytes)
            expect(res).toBeDefined()
          } catch (err: unknown) {
            expect(err instanceof RangeError || err instanceof TypeError).toBe(
              true,
            )
          }
        }
      }),
      { numRuns: 300 },
    )
  })

  it('5. ship always stays inside arena bounds with finite state after arbitrary inputs', () => {
    const stepInputArb = fc.record({
      turn: turnArb,
      thrust: fc.boolean(),
    })

    fc.assert(
      fc.property(
        fc.double({ min: -5000, max: 5000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -5000, max: 5000, noNaN: true, noDefaultInfinity: true }),
        angleArb,
        fc.array(stepInputArb, { minLength: 1, maxLength: 60 }),
        (startX, startY, startAngle, steps) => {
          const ship = createShipState({
            id: asEntityId(1),
            x: startX,
            y: startY,
            angle: startAngle,
          })

          for (const inp of steps) {
            integrateShip(ship, inp, TICK_DT, WORLD_WIDTH, WORLD_HEIGHT)
            expect(Number.isFinite(ship.x)).toBe(true)
            expect(Number.isFinite(ship.y)).toBe(true)
            expect(Number.isFinite(ship.vx)).toBe(true)
            expect(Number.isFinite(ship.vy)).toBe(true)
            expect(Number.isFinite(ship.angle)).toBe(true)
            expect(ship.x).toBeGreaterThanOrEqual(0)
            expect(ship.x).toBeLessThan(WORLD_WIDTH)
            expect(ship.y).toBeGreaterThanOrEqual(0)
            expect(ship.y).toBeLessThan(WORLD_HEIGHT)
            expect(Math.hypot(ship.vx, ship.vy)).toBeLessThanOrEqual(
              MAX_SPEED + 1e-6,
            )
          }
        },
      ),
      { numRuns: 150 },
    )
  })

  it('6. parseClientMessage accepts valid messages and safely rejects malformed payloads', () => {
    const roomIdArb = fc.stringMatching(/^[a-z0-9-]{2,20}$/)
    const nonEmptyTextArb = (max: number) =>
      fc
        .string({ minLength: 1, maxLength: max })
        .filter((s) => s.trim().length > 0)

    const validMsgArb = fc.oneof(
      fc.record({
        v: fc.constant(PROTOCOL_VERSION),
        type: fc.constant('join' as const),
        room: roomIdArb,
        name: nonEmptyTextArb(16),
        codec: fc.constantFrom('binary' as const, 'json' as const),
      }),
      fc.record({
        v: fc.constant(PROTOCOL_VERSION),
        type: fc.constant('chat' as const),
        text: nonEmptyTextArb(200),
      }),
      fc.record({
        v: fc.constant(PROTOCOL_VERSION),
        type: fc.constant('input' as const),
        seq: fc.integer({ min: 0, max: 100000 }),
        tick: fc.integer({ min: 0, max: 100000 }),
        turn: turnArb,
        thrust: fc.boolean(),
        fire: fc.boolean(),
        fireHoming: fc.boolean(),
      }),
      fc.record({
        v: fc.constant(PROTOCOL_VERSION),
        type: fc.constant('codec' as const),
        mode: fc.constantFrom('binary' as const, 'json' as const),
      }),
      fc.record({
        v: fc.constant(PROTOCOL_VERSION),
        type: fc.constant('netcfg' as const),
        rttMs: fc.double({ min: 0, max: 600, noNaN: true }),
        jitterMs: fc.double({ min: 0, max: 200, noNaN: true }),
        dropRate: fc.double({ min: 0, max: 0.3, noNaN: true }),
      }),
      fc.record({
        v: fc.constant(PROTOCOL_VERSION),
        type: fc.constant('ping' as const),
        t: fc.double({ min: 0, max: 1e12, noNaN: true }),
      }),
    )

    fc.assert(
      fc.property(validMsgArb, (msg) => {
        const res = parseClientMessage(JSON.stringify(msg))
        expect(res.ok).toBe(true)
        if (res.ok) {
          expect(res.value.type).toBe(msg.type)
        }
      }),
      { numRuns: 200 },
    )

    const invalidPayloadArb = fc.oneof(
      fc.string().filter((s) => {
        try {
          JSON.parse(s)
          return false
        } catch {
          return true
        }
      }),
      fc
        .integer()
        .filter((v) => v !== PROTOCOL_VERSION)
        .map((v) => JSON.stringify({ v, type: 'ping', t: 1 })),
      fc.constant(JSON.stringify({ v: PROTOCOL_VERSION, type: 'unknown-op' })),
      fc
        .integer()
        .filter((t) => t !== -1 && t !== 0 && t !== 1)
        .map((turn) =>
          JSON.stringify({ v: PROTOCOL_VERSION, type: 'input', seq: 1, turn }),
        ),
      fc.constant(
        JSON.stringify({ v: PROTOCOL_VERSION, type: 'chat', text: '   ' }),
      ),
      fc.constant(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'join',
          room: 'INVALID ROOM!',
          name: 'Ace',
        }),
      ),
      fc.oneof(fc.constant(null), fc.integer(), fc.boolean()),
    )

    fc.assert(
      fc.property(invalidPayloadArb, (raw) => {
        const res = parseClientMessage(raw)
        expect(res.ok).toBe(false)
      }),
      { numRuns: 200 },
    )
  })
})
