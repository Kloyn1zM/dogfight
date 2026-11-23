import type { Server as HttpServer } from 'node:http'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import {
  asEntityId,
  asSeq,
  assertNever,
  binaryCodec,
  jsonCodec,
  type InputCommand,
} from '@dogfight/shared'
import type { ServerConfig } from './config.ts'
import { Match } from './match.ts'
import { NetSimulator, type NetSimConfig } from './netSim.ts'
import {
  encodeMessage,
  makeChat,
  makeError,
  makeEvents,
  makeRoster,
  makeSystem,
  makeWelcome,
  parseClientMessage,
} from './protocol.ts'
import type { Room, RoomManager, RoomPlayer } from './rooms.ts'

class TokenBucket {
  readonly rate: number
  readonly capacity: number
  tokens: number
  lastRefill: number

  constructor(ratePerSec: number, burst = ratePerSec) {
    this.rate = ratePerSec
    this.capacity = burst
    this.tokens = burst
    this.lastRefill = performance.now()
  }

  take(cost = 1): boolean {
    const now = performance.now()
    const elapsedSec = (now - this.lastRefill) / 1000
    this.lastRefill = now
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.rate)
    if (this.tokens < cost) return false
    this.tokens -= cost
    return true
  }
}

interface SocketMeta {
  player: RoomPlayer | null
  room: Room | null
  missedPongs: number
  bucket: TokenBucket
  joinTimer: ReturnType<typeof setTimeout> | null
}

export interface WsStats {
  readonly connections: number
  readonly droppedSlowMessages: number
  readonly totalBytesIn: number
  readonly totalBytesOut: number
  readonly netSim: NetSimConfig
}

export interface WsControl {
  readonly wss: WebSocketServer
  readonly netSim: NetSimulator
  getStats(): WsStats
  closeAllSockets(): Promise<void>
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

function byteLengthOf(payload: string | ArrayBuffer): number {
  if (typeof payload === 'string') return Buffer.byteLength(payload, 'utf8')
  return payload.byteLength
}

export function attachWebSocketServer(
  httpServer: HttpServer,
  { roomManager, config }: { roomManager: RoomManager; config: ServerConfig },
): WsControl {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: config.maxPayloadBytes,
  })

  const netSim = new NetSimulator()
  let nextPlayerId = 1
  const socketMeta = new Map<WebSocket, SocketMeta>()
  let droppedSlowMessages = 0
  let totalBytesIn = 0
  let totalBytesOut = 0

  wss.on('error', (err) => {
    console.error('[WSS] server error:', err.message)
  })

  function safeSend(
    socket: WebSocket | null,
    payload: string | ArrayBuffer,
    { critical = false } = {},
  ): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false

    if (socket.bufferedAmount > config.slowClientThresholdBytes) {
      if (socket.bufferedAmount > config.slowClientThresholdBytes * 4) {
        socket.close(4009, 'Slow client buffer overflow')
        return false
      }
      if (!critical) {
        droppedSlowMessages += 1
        return false
      }
    }

    totalBytesOut += byteLengthOf(payload)
    socket.send(payload)
    return true
  }

  function broadcastRoom(
    room: Room,
    payload: string,
    { critical = false } = {},
  ): void {
    for (const player of room.players.values()) {
      safeSend(player.socket, payload, { critical })
    }
  }

  function ensureMatch(room: Room): Match {
    if (room.match) return room.match
    room.match = new Match(room, {
      onTickBroadcast({
        room: targetRoom,
        baseSnapshot,
        lastProcessedSeqByShip,
        events,
      }) {
        const eventsPayload =
          events.length > 0 ? makeEvents(baseSnapshot.tick, events) : null

        for (const player of targetRoom.players.values()) {
          const seq = lastProcessedSeqByShip.get(player.shipId) ?? asSeq(0)
          const personalSnap = { ...baseSnapshot, lastProcessedSeq: seq }
          const codec = player.codec === 'json' ? jsonCodec : binaryCodec
          const payload = codec.encodeSnapshot(personalSnap)

          netSim.schedule(
            () => {
              safeSend(player.socket, payload, { critical: false })
              if (eventsPayload) {
                safeSend(player.socket, eventsPayload, { critical: false })
              }
            },
            { allowDrop: true },
          )
        }
      },
    })
    return room.match
  }

  const heartbeatTimer = setInterval(() => {
    for (const [socket, meta] of socketMeta) {
      if (socket.readyState !== WebSocket.OPEN) continue
      if (meta.missedPongs >= 2) {
        console.warn(
          `[WS] heartbeat timeout for ${meta.player?.name ?? 'unjoined'}`,
        )
        socket.terminate()
        continue
      }
      meta.missedPongs += 1
      socket.ping()
    }
  }, config.heartbeatIntervalMs)

  wss.on('connection', (socket) => {
    const meta: SocketMeta = {
      player: null,
      room: null,
      missedPongs: 0,
      bucket: new TokenBucket(
        config.rateLimitPerSec,
        config.rateLimitPerSec * 2,
      ),
      joinTimer: setTimeout(() => {
        if (!meta.player && socket.readyState === WebSocket.OPEN) {
          safeSend(socket, makeError('Join timeout (5s)'), { critical: true })
          socket.close(4001, 'Join timeout')
        }
      }, config.joinTimeoutMs),
    }

    socketMeta.set(socket, meta)

    socket.on('error', (err) => {
      console.error('[WS] socket error:', err.message)
    })

    socket.on('pong', () => {
      meta.missedPongs = 0
    })

    socket.on('message', (data, isBinary) => {
      const buf = rawDataToBuffer(data)
      totalBytesIn += buf.byteLength

      if (!meta.bucket.take(1)) {
        safeSend(socket, makeError('Rate limit exceeded'), { critical: true })
        socket.close(4008, 'Rate limit exceeded')
        return
      }

      if (isBinary) {
        if (!meta.player || !meta.room?.match) {
          safeSend(socket, makeError('Join room before sending binary input'), {
            critical: true,
          })
          return
        }
        let input: InputCommand
        try {
          input = binaryCodec.decodeInput(buf)
        } catch (err: unknown) {
          const reason =
            err instanceof Error ? err.message : 'Invalid binary input'
          safeSend(socket, makeError(reason), { critical: true })
          socket.close(1008, 'Invalid binary input')
          return
        }
        const shipId = meta.player.shipId
        const match = meta.room.match
        netSim.schedule(() => match.enqueueInput(shipId, input), {
          allowDrop: true,
        })
        return
      }

      const parsed = parseClientMessage(buf.toString('utf8'))
      if (!parsed.ok) {
        safeSend(socket, makeError(parsed.reason), { critical: true })
        socket.close(parsed.code, parsed.reason)
        return
      }

      const msg = parsed.value

      switch (msg.type) {
        case 'ping': {
          const pongPayload = encodeMessage({
            type: 'pong',
            t: msg.t ?? Date.now(),
          })
          netSim.schedule(
            () => {
              netSim.schedule(
                () => safeSend(socket, pongPayload, { critical: false }),
                { allowDrop: false },
              )
            },
            { allowDrop: false },
          )
          return
        }

        case 'netcfg': {
          netSim.configure(msg)
          const cfgPayload = encodeMessage({
            type: 'netcfg',
            ...netSim.getConfig(),
          })
          if (meta.room) {
            broadcastRoom(meta.room, cfgPayload, { critical: true })
          } else {
            safeSend(socket, cfgPayload, { critical: true })
          }
          return
        }

        case 'join': {
          if (meta.player) {
            safeSend(socket, makeError('Already joined a room'), {
              critical: true,
            })
            return
          }

          const room = roomManager.get(msg.room)
          if (!room) {
            safeSend(socket, makeError(`Room "${msg.room}" not found`), {
              critical: true,
            })
            socket.close(4004, 'Room not found')
            return
          }

          const shipId = asEntityId(nextPlayerId++)
          const player: RoomPlayer = {
            id: `p${shipId}`,
            shipId,
            name: msg.name,
            codec: msg.codec,
            socket,
            joinedAt: Date.now(),
          }

          if (!room.join(player)) {
            safeSend(socket, makeError('Room is full'), { critical: true })
            socket.close(4003, 'Room full')
            return
          }

          const match = ensureMatch(room)
          match.addPlayer(player.shipId)

          if (meta.joinTimer) clearTimeout(meta.joinTimer)
          meta.joinTimer = null
          meta.player = player
          meta.room = room

          safeSend(socket, makeWelcome(player, room, match.tick), {
            critical: true,
          })
          safeSend(
            socket,
            encodeMessage({ type: 'netcfg', ...netSim.getConfig() }),
            { critical: true },
          )
          broadcastRoom(room, makeRoster(room), { critical: true })
          broadcastRoom(
            room,
            makeSystem(`${player.name} приєднався до кімнати`),
          )
          return
        }

        case 'codec': {
          if (!meta.player || !meta.room) {
            safeSend(socket, makeError('Send join first'), { critical: true })
            socket.close(4002, 'Not joined')
            return
          }
          meta.player.codec = msg.mode
          safeSend(
            socket,
            encodeMessage({ type: 'codec', mode: meta.player.codec }),
            { critical: true },
          )
          return
        }

        case 'input': {
          if (!meta.player || !meta.room?.match) {
            safeSend(socket, makeError('Send join first'), { critical: true })
            socket.close(4002, 'Not joined')
            return
          }
          const shipId = meta.player.shipId
          const match = meta.room.match
          const command: InputCommand = {
            seq: msg.seq,
            tick: msg.tick,
            turn: msg.turn,
            thrust: msg.thrust,
            fire: msg.fire,
            fireHoming: msg.fireHoming,
          }
          netSim.schedule(() => match.enqueueInput(shipId, command), {
            allowDrop: true,
          })
          return
        }

        case 'chat': {
          if (!meta.player || !meta.room) {
            safeSend(socket, makeError('Send join first'), { critical: true })
            socket.close(4002, 'Not joined')
            return
          }
          const entry = meta.room.chat(meta.player, msg.text)
          broadcastRoom(meta.room, makeChat(entry))
          return
        }

        default:
          assertNever(msg)
      }
    })

    socket.on('close', () => {
      if (meta.joinTimer) clearTimeout(meta.joinTimer)
      socketMeta.delete(socket)

      if (meta.player && meta.room) {
        meta.room.match?.removePlayer(meta.player.shipId)
        const left = meta.room.leave(meta.player.id)
        if (left) {
          broadcastRoom(meta.room, makeRoster(meta.room), { critical: true })
          broadcastRoom(meta.room, makeSystem(`${left.name} залишив кімнату`))
        }
      }
    })
  })

  return {
    wss,
    netSim,
    getStats(): WsStats {
      return {
        connections: socketMeta.size,
        droppedSlowMessages,
        totalBytesIn,
        totalBytesOut,
        netSim: netSim.getConfig(),
      }
    },
    async closeAllSockets(): Promise<void> {
      clearInterval(heartbeatTimer)
      for (const [socket, meta] of socketMeta) {
        if (meta.joinTimer) clearTimeout(meta.joinTimer)
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1001, 'Server shutting down')
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
