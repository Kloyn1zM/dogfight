import { z } from 'zod'
import { PROTOCOL_VERSION } from './sim/constants.ts'
import { asEntityId, asSeq, asTick, type ParseResult } from './types.ts'

export { PROTOCOL_VERSION }

const ROOM_ID_RE = /^[a-z0-9-]{2,32}$/

const VersionSchema = z.literal(PROTOCOL_VERSION)
const EntityIdSchema = z.number().int().nonnegative().transform(asEntityId)
const TickSchema = z.number().int().nonnegative().transform(asTick)
const SeqSchema = z.number().int().nonnegative().transform(asSeq)
const TurnSchema = z.union([z.literal(-1), z.literal(0), z.literal(1)])
const CodecModeSchema = z.enum(['binary', 'json'])
const DifficultySchema = z.enum(['Normal', 'Hard', 'Chill'])
const PickupEffectSchema = z.enum(['shield', 'rapidFire'])

export const ArenaConfigSchema = z.object({
  targetAsteroids: z.number().int().positive(),
  homingEvery: z.number().int().positive(),
  background: z.string().min(1),
  gridColor: z.string().min(1),
})

export const RoomPublicInfoSchema = z.object({
  id: z.string().regex(ROOM_ID_RE),
  name: z.string().min(1).max(28),
  players: z.number().int().nonnegative(),
  maxPlayers: z.number().int().positive(),
  difficulty: DifficultySchema,
  arena: ArenaConfigSchema,
})

export const RosterEntrySchema = z.object({
  id: z.string().min(1),
  shipId: EntityIdSchema,
  name: z.string().min(1).max(16),
})

export const SnapshotEntitySchema = z.discriminatedUnion('kind', [
  z.object({
    id: EntityIdSchema,
    kind: z.literal('ship'),
    x: z.number().finite(),
    y: z.number().finite(),
    vx: z.number().finite(),
    vy: z.number().finite(),
    angle: z.number().finite(),
    thrusting: z.boolean(),
    shieldActive: z.boolean(),
    rapidFireActive: z.boolean(),
    alive: z.boolean(),
    hp: z.number().int().min(0).max(65535),
    score: z.number().int().min(0).max(65535),
  }),
  z.object({
    id: EntityIdSchema,
    kind: z.literal('bullet'),
    x: z.number().finite(),
    y: z.number().finite(),
    vx: z.number().finite(),
    vy: z.number().finite(),
    angle: z.number().finite(),
    isHoming: z.boolean(),
    ownerId: EntityIdSchema,
  }),
  z.object({
    id: EntityIdSchema,
    kind: z.literal('asteroid'),
    x: z.number().finite(),
    y: z.number().finite(),
    vx: z.number().finite(),
    vy: z.number().finite(),
    angle: z.number().finite(),
    isHoming: z.boolean(),
    radius: z.number().nonnegative(),
    hp: z.number().int().min(0).max(65535),
  }),
  z.object({
    id: EntityIdSchema,
    kind: z.literal('pickup'),
    x: z.number().finite(),
    y: z.number().finite(),
    vx: z.number().finite(),
    vy: z.number().finite(),
    angle: z.number().finite(),
    effect: PickupEffectSchema,
    radius: z.number().nonnegative(),
  }),
])

export const MatchEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('fired'),
    ownerId: EntityIdSchema,
    homing: z.boolean(),
  }),
  z.object({
    type: z.literal('hit'),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  z.object({
    type: z.literal('pickup'),
    shipId: EntityIdSchema,
    effect: PickupEffectSchema,
  }),
  z.object({
    type: z.literal('exploded'),
    kind: z.enum(['ship', 'asteroid']),
    big: z.boolean(),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
])

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    v: VersionSchema,
    type: z.literal('join'),
    room: z.string().regex(ROOM_ID_RE, 'Invalid room id'),
    name: z.string().trim().min(1, 'Name too short').max(16, 'Name too long'),
    codec: CodecModeSchema.optional().default('binary'),
  }),
  z.object({
    v: VersionSchema,
    type: z.literal('chat'),
    text: z.string().trim().min(1, 'Chat empty').max(200, 'Chat too long'),
  }),
  z.object({
    v: VersionSchema,
    type: z.literal('input'),
    seq: SeqSchema,
    tick: TickSchema.optional().default(asTick(0)),
    turn: TurnSchema,
    thrust: z.boolean().optional().default(false),
    fire: z.boolean().optional().default(false),
    fireHoming: z.boolean().optional().default(false),
  }),
  z.object({
    v: VersionSchema,
    type: z.literal('codec'),
    mode: CodecModeSchema,
  }),
  z.object({
    v: VersionSchema,
    type: z.literal('netcfg'),
    rttMs: z.number().finite().min(0).max(600).optional().default(0),
    jitterMs: z.number().finite().min(0).max(200).optional().default(0),
    dropRate: z.number().finite().min(0).max(0.3).optional().default(0),
  }),
  z.object({
    v: VersionSchema,
    type: z.literal('ping'),
    t: z.number().finite().optional(),
  }),
])

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    v: VersionSchema,
    type: z.literal('welcome'),
    playerId: z.string().min(1),
    shipId: EntityIdSchema,
    name: z.string().min(1),
    codec: CodecModeSchema,
    worldWidth: z.number().positive(),
    worldHeight: z.number().positive(),
    tick: TickSchema,
    room: RoomPublicInfoSchema,
  }),
  z.object({
    v: VersionSchema,
    type: z.literal('roster'),
    roomId: z.string().min(1),
    players: z.array(RosterEntrySchema),
  }),
  z.object({
    v: VersionSchema,
    type: z.literal('chat'),
    playerId: z.string().min(1),
    name: z.string().min(1),
    text: z.string().min(1),
    t: z.number().finite(),
  }),
  z.object({
    v: VersionSchema,
    type: z.literal('system'),
    text: z.string().min(1),
    t: z.number().finite(),
  }),
  z.object({
    v: VersionSchema,
    type: z.literal('events'),
    tick: TickSchema,
    events: z.array(MatchEventSchema),
  }),
  z.object({
    v: VersionSchema,
    type: z.literal('error'),
    reason: z.string().min(1),
  }),
  z.object({
    v: VersionSchema,
    type: z.literal('pong'),
    t: z.number().finite(),
  }),
  z.object({
    v: VersionSchema,
    type: z.literal('codec'),
    mode: CodecModeSchema,
  }),
  z.object({
    v: VersionSchema,
    type: z.literal('netcfg'),
    rttMs: z.number().finite(),
    jitterMs: z.number().finite(),
    dropRate: z.number().finite(),
    droppedPackets: z.number().int().nonnegative().optional(),
  }),
  z.object({
    v: VersionSchema,
    type: z.literal('snapshot'),
    tick: TickSchema,
    lastProcessedSeq: SeqSchema,
    matchTimeMs: z.number().int().nonnegative(),
    entities: z.array(SnapshotEntitySchema),
  }),
])

export type ClientMessage = z.infer<typeof ClientMessageSchema>
export type ServerMessage = z.infer<typeof ServerMessageSchema>

export type ClientMessagePayload =
  | { type: 'join'; room: string; name: string; codec?: 'binary' | 'json' }
  | { type: 'chat'; text: string }
  | {
      type: 'input'
      seq: number
      tick: number
      turn: -1 | 0 | 1
      thrust: boolean
      fire: boolean
      fireHoming: boolean
    }
  | { type: 'codec'; mode: 'binary' | 'json' }
  | { type: 'netcfg'; rttMs: number; jitterMs: number; dropRate: number }
  | { type: 'ping'; t: number }

export function encodeJsonMessage(
  msg: Record<string, unknown> & { readonly type: string },
): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...msg })
}

function parseRawJson(raw: unknown): ParseResult<unknown> {
  if (typeof raw !== 'string') {
    return { ok: true, value: raw }
  }
  try {
    const value: unknown = JSON.parse(raw)
    return { ok: true, value }
  } catch {
    return { ok: false, code: 1007, reason: 'Invalid JSON payload' }
  }
}

export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  const json = parseRawJson(raw)
  if (!json.ok) return json

  const parsed = ClientMessageSchema.safeParse(json.value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const pathLabel = issue?.path.length ? `${issue.path.join('.')}: ` : ''
    return {
      ok: false,
      code: 1008,
      reason: `${pathLabel}${issue?.message ?? 'Invalid client message'}`,
    }
  }
  return { ok: true, value: parsed.data }
}

export function parseServerMessage(raw: unknown): ParseResult<ServerMessage> {
  const json = parseRawJson(raw)
  if (!json.ok) return json

  const parsed = ServerMessageSchema.safeParse(json.value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      code: 1008,
      reason: issue?.message ?? 'Invalid server message',
    }
  }
  return { ok: true, value: parsed.data }
}
