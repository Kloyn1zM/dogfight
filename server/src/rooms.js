import { EventEmitter } from 'node:events'
import { createMatchLog } from './log/matchlog.js'

const ARENA_PRESETS = {
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

function slugify(name) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 22)
  return base || 'room'
}

export class Room extends EventEmitter {
  constructor({
    id,
    name,
    difficulty = 'Normal',
    maxPlayers = 8,
    persistent = false,
  }) {
    super()
    this.id = id
    this.name = name
    this.difficulty = ARENA_PRESETS[difficulty] ? difficulty : 'Normal'
    this.maxPlayers = maxPlayers
    this.persistent = persistent
    this.arena = { ...ARENA_PRESETS[this.difficulty] }
    this.players = new Map()
    this.match = null
  }

  get playerCount() {
    return this.players.size
  }

  isFull() {
    return this.players.size >= this.maxPlayers
  }

  getRoster() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      shipId: p.shipId,
      name: p.name,
    }))
  }

  toPublicInfo() {
    return {
      id: this.id,
      name: this.name,
      players: this.players.size,
      maxPlayers: this.maxPlayers,
      difficulty: this.difficulty,
      arena: this.arena,
    }
  }

  recordEvent(type, payload = {}) {
    this.emit('event', {
      t: Date.now(),
      roomId: this.id,
      type,
      ...payload,
    })
  }

  join(player) {
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

  leave(playerId) {
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

  chat(player, text) {
    const entry = {
      playerId: player.id,
      name: player.name,
      text,
      t: Date.now(),
    }
    this.emit('chat', entry)
    this.recordEvent('chat', entry)
    return entry
  }
}

export class RoomManager {
  #rooms = new Map()
  #logs = new Map()
  #closing = new Set()
  #counter = 1

  constructor({ maxRooms = 20, maxPlayersPerRoom = 8, logDir = null } = {}) {
    this.maxRooms = maxRooms
    this.maxPlayersPerRoom = maxPlayersPerRoom
    this.logDir = logDir
  }

  get size() {
    return this.#rooms.size
  }

  allRooms() {
    return [...this.#rooms.values()]
  }

  totalPlayers() {
    let total = 0
    for (const room of this.#rooms.values()) {
      total += room.playerCount
    }
    return total
  }

  list() {
    return [...this.#rooms.values()].map((r) => r.toPublicInfo())
  }

  get(id) {
    return this.#rooms.get(id)
  }

  seedDefaults() {
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
  }) {
    if (this.#rooms.size >= this.maxRooms) {
      throw new Error(`Room limit reached (${this.maxRooms})`)
    }

    const cleanName = String(name || '')
      .trim()
      .slice(0, 28)
    if (!cleanName) {
      throw new Error('Room name is required')
    }

    const roomId =
      id || `${slugify(cleanName)}-${String(this.#counter++).padStart(2, '0')}`
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
      console.error(`[Room:${room.id}] error:`, err.message)
    })

    this.#rooms.set(room.id, room)

    if (this.logDir) {
      const log = createMatchLog(room, this.logDir)
      this.#logs.set(room.id, log)
      room.recordEvent('room.created', {
        name: room.name,
        difficulty: room.difficulty,
      })
    }

    if (!persistent) {
      room.once('empty', () => {
        this.delete(room.id)
      })
    }

    return room
  }

  async delete(id) {
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

  async closeAll() {
    for (const room of this.#rooms.values()) {
      room.match?.stop()
    }
    const closing = [...this.#closing]
    for (const log of this.#logs.values()) {
      closing.push(log.close())
    }
    this.#logs.clear()
    this.#rooms.clear()
    await Promise.allSettled(closing)
  }
}
