import { z } from 'zod'
import { PROTOCOL_VERSION } from '../sim/constants.ts'
import { SnapshotEntitySchema } from '../protocol.ts'
import {
  asSeq,
  asTick,
  type Codec,
  type InputCommand,
  type Snapshot,
} from '../types.ts'

const JsonInputPacketSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('input'),
  seq: z.number().int().nonnegative().transform(asSeq),
  tick: z.number().int().nonnegative().transform(asTick),
  turn: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  thrust: z.boolean(),
  fire: z.boolean(),
  fireHoming: z.boolean().optional().default(false),
})

const JsonSnapshotPacketSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('snapshot'),
  tick: z.number().int().nonnegative().transform(asTick),
  lastProcessedSeq: z.number().int().nonnegative().transform(asSeq),
  matchTimeMs: z.number().int().nonnegative(),
  entities: z.array(SnapshotEntitySchema),
})

function ensureObject(raw: unknown): unknown {
  if (typeof raw === 'string') {
    const parsed: unknown = JSON.parse(raw)
    return parsed
  }
  return raw
}

export const jsonCodec: Codec = {
  name: 'json',
  isBinary: false,

  encodeInput(input: InputCommand): string {
    return JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'input',
      seq: input.seq,
      tick: input.tick,
      turn: input.turn,
      thrust: input.thrust,
      fire: input.fire,
      fireHoming: input.fireHoming,
    })
  },

  decodeInput(raw: unknown): InputCommand {
    const res = JsonInputPacketSchema.safeParse(ensureObject(raw))
    if (!res.success) {
      throw new RangeError('Invalid JSON input packet')
    }
    const { seq, tick, turn, thrust, fire, fireHoming } = res.data
    return { seq, tick, turn, thrust, fire, fireHoming }
  },

  encodeSnapshot(snapshot: Snapshot): string {
    return JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'snapshot',
      tick: snapshot.tick,
      lastProcessedSeq: snapshot.lastProcessedSeq,
      matchTimeMs: snapshot.matchTimeMs,
      entities: snapshot.entities,
    })
  },

  decodeSnapshot(raw: unknown): Snapshot {
    const res = JsonSnapshotPacketSchema.safeParse(ensureObject(raw))
    if (!res.success) {
      throw new RangeError('Invalid JSON snapshot packet')
    }
    const { tick, lastProcessedSeq, matchTimeMs, entities } = res.data
    return { tick, lastProcessedSeq, matchTimeMs, entities }
  },
}
