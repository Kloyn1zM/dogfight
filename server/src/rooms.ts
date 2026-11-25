import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import type {
  ArenaConfig,
  CodecMode,
  Difficulty,
  EntityId,
  RoomPublicInfo,
  RosterEntry,
} from '@dogfight/shared'
import { createMatchLog, type MatchLogHandle } from './log/matchlog.ts'
import type { ServerLogger } from './logger.ts'
import type { Match } from './match.ts'

const ARENA_PRESETS: Readonly<Record<Difficulty, ArenaConfig>> = {
  Normal: {
    targetAsteroids: 6,
    homingEvery: 4,
    background: '#0e1016',
    gridColor: '#1a2030',
  },
  Hard: {
    targetAsteroids: 10,
    homingEvery: 2,
    background: '#160d12',
    gridColor: '#2d1621',
  },
  Chill: {
    targetAsteroids: 4,
    homingEvery: 6,
    background: '#0b1318',
    gridColor: '#152834',
  },
}

export interface RoomPlayer {
  readonly id: string
  readonly shipId: EntityId
  readonly name: string
  codec: CodecMode
  readonly socket: WebSocket | null
  readonly joinedAt: number
}

export interface ChatEntry {
  readonly playerId: string
  readonly name: string
  readonly text: string
  readonly t: number
}

export interface RoomLogEvent {
  readonly t: number
  readonly roomId: string
  readonly type: string
  readonly [key: string]: unknown
}

export type RoomEvents = {
  join: [player: RoomPlayer]
  leave: [player: RoomPlayer]
  chat: [entry: ChatEntry]
  empty: [room: Room]
  event: [evt: RoomLogEvent]
  error: [err: Error]
}

export interface CreateRoomOptions {
  readonly id?: string
  readonly name: string
  readonly difficulty?: Difficulty
  readonly maxPlayers?: number
  readonly persistent?: boolean
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 22)
  return base || 'room'
}

export class Room extends EventEmitter<RoomEvents> {
  readonly id: string
  readonly name: string
  readonly difficulty: Difficulty
  readonly maxPlayers: number
  readonly persistent: boolean
  readonly arena: ArenaConfig
  readonly players = new Map<string, RoomPlayer>()
  match: Match | null = null

  constructor({
    id,
    name,
    difficulty = 'Normal',
    maxPlayers = 8,
    persistent = false,
  }: {
    id: string
    name: string
    difficulty?: Difficulty
    maxPlayers?: number
    persistent?: boolean
  }) {
    super()
    this.id = id
    this.name = name
    this.difficulty = difficulty
    this.maxPlayers = maxPlayers
    this.persistent = persistent
    this.arena = { ...ARENA_PRESETS[this.difficulty] }
  }

  get playerCount(): number {
    return this.players.size
  }

  isFull(): boolean {
    return this.players.size >= this.maxPlayers
  }

  getRoster(): RosterEntry[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      shipId: p.shipId,
      name: p.name,
    }))
  }

  toPublicInfo(): RoomPublicInfo {
    return {
      id: this.id,
      name: this.name,
      players: this.players.size,
      maxPlayers: this.maxPlayers,
      difficulty: this.difficulty,
      arena: this.arena,
    }
  }

  recordEvent(type: string, payload: Record<string, unknown> = {}): void {
    this.emit('event', {
      t: Date.now(),
      roomId: this.id,
      type,
      ...payload,
    })
  }

  join(player: RoomPlayer): boolean {
    if (this.isFull()) return false
    this.players.set(player.id, player)
    this.emit('join', player)
    this.recordEvent('join', {
      playerId: player.id,
      shipId: player.shipId,
      name: player.name,
    })
    return true
  }

  leave(playerId: string): RoomPlayer | null {
    const player = this.players.get(playerId)
    if (!player) return null
    this.players.delete(playerId)
    this.emit('leave', player)
    this.recordEvent('leave', { playerId: player.id, name: player.name })
    if (this.players.size === 0) {
      this.emit('empty', this)
    }
    return player
  }

  chat(player: RoomPlayer, text: string): ChatEntry {
    const entry: ChatEntry = {
      playerId: player.id,
      name: player.name,
      text,
      t: Date.now(),
    }
    this.emit('chat', entry)
    this.recordEvent('chat', { ...entry })
    return entry
  }
}

export class RoomManager {
  #rooms = new Map<string, Room>()
  #logs = new Map<string, MatchLogHandle>()
  #closing = new Set<Promise<void>>()
  #counter = 1

  readonly maxRooms: number
  readonly maxPlayersPerRoom: number
  readonly logDir: string | null
  readonly #logger?: ServerLogger

  constructor({
    maxRooms = 20,
    maxPlayersPerRoom = 16,
    logDir = null,
    logger,
  }: {
    maxRooms?: number
    maxPlayersPerRoom?: number
    logDir?: string | null
    logger?: ServerLogger
  } = {}) {
    this.maxRooms = maxRooms
    this.maxPlayersPerRoom = maxPlayersPerRoom
    this.logDir = logDir
    this.#logger = logger
  }

  get size(): number {
    return this.#rooms.size
  }

  allRooms(): Room[] {
    return [...this.#rooms.values()]
  }

  totalPlayers(): number {
    let total = 0
    for (const room of this.#rooms.values()) {
      total += room.playerCount
    }
    return total
  }

  list(): RoomPublicInfo[] {
    return [...this.#rooms.values()].map((r) => r.toPublicInfo())
  }

  get(id: string): Room | undefined {
    return this.#rooms.get(id)
  }

  seedDefaults(): void {
    this.create({
      id: 'nebula-alpha',
      name: 'Nebula Alpha',
      difficulty: 'Normal',
      persistent: true,
    })
    this.create({
      id: 'crimson-swarm',
      name: 'Crimson Swarm',
      difficulty: 'Hard',
      persistent: true,
    })
    this.create({
      id: 'training-yard',
      name: 'Training Yard',
      difficulty: 'Chill',
      maxPlayers: Math.min(4, this.maxPlayersPerRoom),
      persistent: true,
    })
  }

  create({
    id,
    name,
    difficulty = 'Normal',
    maxPlayers = this.maxPlayersPerRoom,
    persistent = false,
  }: CreateRoomOptions): Room {
    if (this.#rooms.size >= this.maxRooms) {
      throw new Error(`Room limit reached (${this.maxRooms})`)
    }

    const cleanName = name.trim().slice(0, 28)
    if (!cleanName) {
      throw new Error('Room name is required')
    }

    const roomId =
      id ?? `${slugify(cleanName)}-${String(this.#counter++).padStart(2, '0')}`
    if (this.#rooms.has(roomId)) {
      throw new Error(`Room "${roomId}" already exists`)
    }

    const room = new Room({
      id: roomId,
      name: cleanName,
      difficulty,
      maxPlayers: Math.min(maxPlayers, this.maxPlayersPerRoom),
      persistent,
    })

    room.on('error', (err) => {
      this.#logger?.error({ roomId: room.id, err: err.message }, 'room error')
    })

    this.#rooms.set(room.id, room)

    if (this.logDir) {
      const log = createMatchLog(room, this.logDir, this.#logger)
      this.#logs.set(room.id, log)
      room.recordEvent('room.created', {
        name: room.name,
        difficulty: room.difficulty,
      })
    }

    if (!persistent) {
      room.once('empty', () => {
        void this.delete(room.id)
      })
    }

    return room
  }

  async delete(id: string): Promise<void> {
    const room = this.#rooms.get(id)
    if (!room) return
    room.match?.stop()
    this.#rooms.delete(id)
    const log = this.#logs.get(id)
    if (log) {
      this.#logs.delete(id)
      const pending = log.close().finally(() => {
        this.#closing.delete(pending)
      })
      this.#closing.add(pending)
      await pending
    }
  }

  async closeAll(): Promise<void> {
    for (const room of this.#rooms.values()) {
      room.match?.stop()
    }
    const closing: Promise<void>[] = [...this.#closing]
    for (const log of this.#logs.values()) {
      closing.push(log.close())
    }
    this.#logs.clear()
    this.#rooms.clear()
    await Promise.allSettled(closing)
  }
}
