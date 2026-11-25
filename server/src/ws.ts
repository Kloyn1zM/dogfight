import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
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
import type { ServerLogger } from './logger.ts'
import { Match } from './match.ts'
import type { MetricsCollector } from './metrics.ts'
import { NetSimulator, type NetSimConfig } from './netSim.ts'
import {
  encodeMessage,
  makeChat,
  makeError,
  makeEvents,
  makeRoster,
  makeShutdown,
  makeSystem,
  makeWelcome,
  parseClientMessage,
} from './protocol.ts'
import { TokenBucket } from './rateLimit.ts'
import type { Room, RoomManager, RoomPlayer } from './rooms.ts'

interface SocketMeta {
  player: RoomPlayer | null
  room: Room | null
  ip: string
  missedPongs: number
  bucket: TokenBucket
  joinTimer: ReturnType<typeof setTimeout> | null
}

export interface WsStats {
  readonly connections: number
  readonly droppedSlowMessages: number
  readonly totalBytesIn: number
  readonly totalBytesOut: number
  readonly rejectedOrigins: number
  readonly rejectedIpLimits: number
  readonly netSim: NetSimConfig
}

export interface WsControl {
  readonly wss: WebSocketServer
  readonly netSim: NetSimulator
  getStats(): WsStats
  stopAccepting(): void
  closeAllSockets(reason?: string): Promise<void>
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

export function getClientIp(
  req: IncomingMessage,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for']
    const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0]
    const trimmed = first?.trim()
    if (trimmed) return trimmed
  }
  return req.socket.remoteAddress ?? 'unknown'
}

export function isOriginAllowed(
  originHeader: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (originHeader === undefined) return true
  const normalized = originHeader.trim().replace(/\/+$/, '').toLowerCase()
  if (!normalized) return false
  return (
    allowedOrigins.includes('*') || allowedOrigins.includes(normalized)
  )
}

function rejectUpgrade(
  socket: Duplex,
  statusCode: number,
  statusText: string,
): void {
  if (!socket.destroyed) {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    )
    socket.destroy()
  }
}

export function attachWebSocketServer(
  httpServer: HttpServer,
  {
    roomManager,
    config,
    logger,
    metrics,
  }: {
    roomManager: RoomManager
    config: ServerConfig
    logger: ServerLogger
    metrics: MetricsCollector
  },
): WsControl {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxPayloadBytes,
  })

  const netSim = new NetSimulator()
  let nextPlayerId = 1
  const socketMeta = new Map<WebSocket, SocketMeta>()
  const connectionsByIp = new Map<string, number>()
  let accepting = true
  let droppedSlowMessages = 0
  let totalBytesIn = 0
  let totalBytesOut = 0
  let rejectedOrigins = 0
  let rejectedIpLimits = 0

  wss.on('error', (err) => {
    logger.error({ err: err.message }, 'websocket server error')
  })

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    )
    if (url.pathname !== '/ws') {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }

    if (!accepting) {
      rejectUpgrade(socket, 503, 'Service Unavailable')
      return
    }

    const ip = getClientIp(req, config.trustProxy)
    const origin = req.headers.origin
    if (!isOriginAllowed(origin, config.allowedOrigins)) {
      rejectedOrigins += 1
      logger.warn({ ip, origin }, 'ws upgrade rejected: origin not allowed')
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }

    const activeFromIp = connectionsByIp.get(ip) ?? 0
    if (activeFromIp >= config.maxConnectionsPerIp) {
      rejectedIpLimits += 1
      logger.warn(
        { ip, activeFromIp, limit: config.maxConnectionsPerIp },
        'ws upgrade rejected: per-ip connection limit reached',
      )
      rejectUpgrade(socket, 429, 'Too Many Requests')
      return
    }

    if (roomManager.totalPlayers() >= config.maxTotalPlayers) {
      logger.warn(
        { ip, totalPlayers: roomManager.totalPlayers() },
        'ws upgrade rejected: server player capacity reached',
      )
      rejectUpgrade(socket, 503, 'Server Full')
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  function safeSend(
    socket: WebSocket | null,
    payload: string | ArrayBuffer,
    { critical = false } = {},
  ): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false

    if (socket.bufferedAmount > config.slowClientThresholdBytes) {
      if (socket.bufferedAmount > config.slowClientThresholdBytes * 4) {
        const meta = socketMeta.get(socket)
        logger.warn(
          {
            roomId: meta?.room?.id,
            playerId: meta?.player?.id,
            ip: meta?.ip,
            bufferedAmount: socket.bufferedAmount,
          },
          'closing slow client due to buffer overflow',
        )
        socket.close(4009, 'Slow client buffer overflow')
        return false
      }
      if (!critical) {
        droppedSlowMessages += 1
        return false
      }
    }

    const bytes = byteLengthOf(payload)
    totalBytesOut += bytes
    metrics.recordMessageOut(bytes)
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
        logger.warn(
          {
            roomId: meta.room?.id,
            playerId: meta.player?.id,
            ip: meta.ip,
          },
          'ws heartbeat timeout, terminating socket',
        )
        socket.terminate()
        continue
      }
      meta.missedPongs += 1
      socket.ping()
    }
  }, config.heartbeatIntervalMs)
  heartbeatTimer.unref()

  wss.on('connection', (socket, req) => {
    const ip = getClientIp(req, config.trustProxy)
    connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1)

    const meta: SocketMeta = {
      player: null,
      room: null,
      ip,
      missedPongs: 0,
      bucket: new TokenBucket(
        config.rateLimitPerSec,
        config.rateLimitPerSec * 2,
      ),
      joinTimer: setTimeout(() => {
        if (!meta.player && socket.readyState === WebSocket.OPEN) {
          logger.warn({ ip }, 'ws join timeout')
          safeSend(socket, makeError('Join timeout (5s)'), { critical: true })
          socket.close(4001, 'Join timeout')
        }
      }, config.joinTimeoutMs),
    }

    socketMeta.set(socket, meta)

    socket.on('error', (err) => {
      logger.error(
        {
          roomId: meta.room?.id,
          playerId: meta.player?.id,
          ip: meta.ip,
          err: err.message,
        },
        'ws socket error',
      )
    })

    socket.on('pong', () => {
      meta.missedPongs = 0
    })

    socket.on('message', (data, isBinary) => {
      const buf = rawDataToBuffer(data)
      totalBytesIn += buf.byteLength
      metrics.recordMessageIn(buf.byteLength)

      if (!meta.bucket.take(1)) {
        logger.warn(
          { roomId: meta.room?.id, playerId: meta.player?.id, ip: meta.ip },
          'ws rate limit exceeded',
        )
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
          logger.warn(
            {
              roomId: meta.room.id,
              playerId: meta.player.id,
              ip: meta.ip,
              reason,
            },
            'invalid binary input frame',
          )
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
        logger.warn(
          {
            roomId: meta.room?.id,
            playerId: meta.player?.id,
            ip: meta.ip,
            code: parsed.code,
            reason: parsed.reason,
          },
          'invalid client json message',
        )
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

          if (roomManager.totalPlayers() >= config.maxTotalPlayers) {
            safeSend(socket, makeError('Server player limit reached'), {
              critical: true,
            })
            socket.close(4003, 'Server full')
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

          logger.info(
            {
              roomId: room.id,
              playerId: player.id,
              shipId: player.shipId,
              ip: meta.ip,
              codec: player.codec,
            },
            'player joined room',
          )

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
          logger.info(
            { roomId: meta.room.id, playerId: meta.player.id },
            'room chat message',
          )
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

      const remaining = (connectionsByIp.get(meta.ip) ?? 1) - 1
      if (remaining <= 0) connectionsByIp.delete(meta.ip)
      else connectionsByIp.set(meta.ip, remaining)

      if (meta.player && meta.room) {
        logger.info(
          { roomId: meta.room.id, playerId: meta.player.id, ip: meta.ip },
          'player disconnected',
        )
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
        rejectedOrigins,
        rejectedIpLimits,
        netSim: netSim.getConfig(),
      }
    },
    stopAccepting(): void {
      accepting = false
    },
    async closeAllSockets(reason = 'Server shutting down'): Promise<void> {
      accepting = false
      clearInterval(heartbeatTimer)
      const shutdownPayload = makeShutdown(reason)
      for (const [socket, meta] of socketMeta) {
        if (meta.joinTimer) clearTimeout(meta.joinTimer)
        if (socket.readyState === WebSocket.OPEN) {
          safeSend(socket, shutdownPayload, { critical: true })
          socket.close(1001, reason)
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
