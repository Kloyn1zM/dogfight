export type EntityId = number & { readonly __brand: 'EntityId' }
export type Tick = number & { readonly __brand: 'Tick' }
export type Seq = number & { readonly __brand: 'Seq' }

export function asEntityId(n: number): EntityId {
  // Zero-cost nominal brand constructor for entity identifiers
  return n as EntityId
}

export function asTick(n: number): Tick {
  // Zero-cost nominal brand constructor for simulation tick numbers
  return n as Tick
}

export function asSeq(n: number): Seq {
  // Zero-cost nominal brand constructor for client input sequence numbers
  return n as Seq
}

export type TurnDirection = -1 | 0 | 1
export type CodecMode = 'binary' | 'json'
export type PickupEffect = 'shield' | 'rapidFire'
export type Difficulty = 'Normal' | 'Hard' | 'Chill'
export type EntityKind = 'ship' | 'bullet' | 'asteroid' | 'pickup'

export interface ArenaConfig {
  readonly targetAsteroids: number
  readonly homingEvery: number
  readonly background: string
  readonly gridColor: string
}

export interface RoomPublicInfo {
  readonly id: string
  readonly name: string
  readonly players: number
  readonly maxPlayers: number
  readonly difficulty: Difficulty
  readonly arena: ArenaConfig
}

export interface RosterEntry {
  readonly id: string
  readonly shipId: EntityId
  readonly name: string
}

export interface InputCommand {
  readonly seq: Seq
  readonly tick: Tick
  readonly turn: TurnDirection
  readonly thrust: boolean
  readonly fire: boolean
  readonly fireHoming: boolean
}

export interface ShipSnapshot {
  readonly id: EntityId
  readonly kind: 'ship'
  readonly x: number
  readonly y: number
  readonly vx: number
  readonly vy: number
  readonly angle: number
  readonly thrusting: boolean
  readonly shieldActive: boolean
  readonly rapidFireActive: boolean
  readonly alive: boolean
  readonly hp: number
  readonly score: number
}

export interface BulletSnapshot {
  readonly id: EntityId
  readonly kind: 'bullet'
  readonly x: number
  readonly y: number
  readonly vx: number
  readonly vy: number
  readonly angle: number
  readonly isHoming: boolean
  readonly ownerId: EntityId
}

export interface AsteroidSnapshot {
  readonly id: EntityId
  readonly kind: 'asteroid'
  readonly x: number
  readonly y: number
  readonly vx: number
  readonly vy: number
  readonly angle: number
  readonly isHoming: boolean
  readonly radius: number
  readonly hp: number
}

export interface PickupSnapshot {
  readonly id: EntityId
  readonly kind: 'pickup'
  readonly x: number
  readonly y: number
  readonly vx: number
  readonly vy: number
  readonly angle: number
  readonly effect: PickupEffect
  readonly radius: number
}

export type SnapshotEntity =
  ShipSnapshot | BulletSnapshot | AsteroidSnapshot | PickupSnapshot

export interface Snapshot {
  readonly tick: Tick
  readonly lastProcessedSeq: Seq
  readonly matchTimeMs: number
  readonly entities: readonly SnapshotEntity[]
}

export type MatchEvent =
  | {
      readonly type: 'fired'
      readonly ownerId: EntityId
      readonly homing: boolean
    }
  | { readonly type: 'hit'; readonly x: number; readonly y: number }
  | {
      readonly type: 'pickup'
      readonly shipId: EntityId
      readonly effect: PickupEffect
    }
  | {
      readonly type: 'exploded'
      readonly kind: 'ship' | 'asteroid'
      readonly big: boolean
      readonly x: number
      readonly y: number
    }

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: number; readonly reason: string }

export interface Codec {
  readonly name: CodecMode
  readonly isBinary: boolean
  encodeInput(input: InputCommand): string | ArrayBuffer
  decodeInput(raw: unknown): InputCommand
  encodeSnapshot(snapshot: Snapshot): string | ArrayBuffer
  decodeSnapshot(raw: unknown): Snapshot
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated union member: ${String(value)}`)
}
