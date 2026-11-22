import { WebSocket, WebSocketServer } from 'ws'
import { binaryCodec, jsonCodec } from '@dogfight/shared'
import { Match } from './match.js'
import { NetSimulator } from './netSim.js'
import {
  encodeMessage,
  makeChat,
  makeError,
  makeEvents,
  makeRoster,
  makeSystem,
  makeWelcome,
  validateClientMessage,
} from './protocol.js'

class TokenBucket {
  constructor(ratePerSec, burst = ratePerSec) {
    this.rate = ratePerSec
    this.capacity = burst
    this.tokens = burst
    this.lastRefill = performance.now()
  }

  take(cost = 1) {
    const now = performance.now()
    const elapsedSec = (now - this.lastRefill) / 1000
    this.lastRefill = now
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.rate)
    if (this.tokens < cost) return false
    this.tokens -= cost
    return true
  }
}

function byteLengthOf(payload) {
  if (typeof payload === 'string') return Buffer.byteLength(payload, 'utf8')
  if (payload instanceof ArrayBuffer) return payload.byteLength
  if (ArrayBuffer.isView(payload)) return payload.byteLength
  return 0
}

export function attachWebSocketServer(httpServer, { roomManager, config }) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: config.maxPayloadBytes,
  })

  const netSim = new NetSimulator()
  let nextPlayerId = 1
  const socketMeta = new Map()
  let droppedSlowMessages = 0
  let totalBytesIn = 0
  let totalBytesOut = 0

  wss.on('error', (err) => {
    console.error('[WSS] server error:', err.message)
  })

  function safeSend(socket, payload, { critical = false } = {}) {
    if (socket.readyState !== WebSocket.OPEN) return false

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

  function broadcastRoom(room, payload, { critical = false } = {}) {
    for (const player of room.players.values()) {
      safeSend(player.socket, payload, { critical })
    }
  }

  function ensureMatch(room) {
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
          const seq = lastProcessedSeqByShip.get(player.shipId) || 0
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
          `[WS] heartbeat timeout for ${meta.player?.name || 'unjoined'}`,
        )
        socket.terminate()
        continue
      }
      meta.missedPongs += 1
      socket.ping()
    }
  }, config.heartbeatIntervalMs)

  wss.on('connection', (socket) => {
    const meta = {
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
      totalBytesIn += byteLengthOf(data)

      if (!meta.bucket.take(1)) {
        safeSend(socket, makeError('Rate limit exceeded'), { critical: true })
        socket.close(4008, 'Rate limit exceeded')
        return
      }

      // Бінарні фрейми: тільки вхідні команди керування (12 байтів, DataView)
      if (isBinary) {
        if (!meta.player || !meta.room?.match) {
          safeSend(socket, makeError('Join room before sending binary input'), {
            critical: true,
          })
          return
        }
        let input
        try {
          input = binaryCodec.decodeInput(data)
        } catch (err) {
          safeSend(socket, makeError(err.message), { critical: true })
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

      const validation = validateClientMessage(data.toString('utf8'))
      if (!validation.ok) {
        safeSend(socket, makeError(validation.reason), { critical: true })
        socket.close(validation.code, validation.reason)
        return
      }

      const { msg } = validation

      if (msg.type === 'ping') {
        const pongPayload = encodeMessage({ type: 'pong', t: msg.t })
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

      if (msg.type === 'netcfg') {
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

      if (msg.type === 'join') {
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

        const shipId = nextPlayerId++
        const player = {
          id: `p${shipId}`,
          shipId,
          name: msg.name,
          codec: msg.codec || 'binary',
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

        clearTimeout(meta.joinTimer)
        meta.joinTimer = null
        meta.player = player
        meta.room = room

        safeSend(socket, makeWelcome(player, room, match), { critical: true })
        safeSend(
          socket,
          encodeMessage({ type: 'netcfg', ...netSim.getConfig() }),
          { critical: true },
        )
        broadcastRoom(room, makeRoster(room), { critical: true })
        broadcastRoom(room, makeSystem(`${player.name} приєднався до кімнати`))
        return
      }

      if (!meta.player || !meta.room) {
        safeSend(socket, makeError('Send join first'), { critical: true })
        socket.close(4002, 'Not joined')
        return
      }

      if (msg.type === 'codec') {
        meta.player.codec = msg.mode
        safeSend(
          socket,
          encodeMessage({ type: 'codec', mode: meta.player.codec }),
          { critical: true },
        )
        return
      }

      if (msg.type === 'input') {
        const shipId = meta.player.shipId
        const match = meta.room.match
        netSim.schedule(() => match?.enqueueInput(shipId, msg), {
          allowDrop: true,
        })
        return
      }

      if (msg.type === 'chat') {
        const entry = meta.room.chat(meta.player, msg.text)
        broadcastRoom(meta.room, makeChat(entry))
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
    getStats() {
      return {
        connections: socketMeta.size,
        droppedSlowMessages,
        totalBytesIn,
        totalBytesOut,
        netSim: netSim.getConfig(),
      }
    },
    async closeAllSockets() {
      clearInterval(heartbeatTimer)
      for (const [socket, meta] of socketMeta) {
        if (meta.joinTimer) clearTimeout(meta.joinTimer)
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1001, 'Server shutting down')
        }
      }
      await new Promise((resolve) => wss.close(resolve))
    },
  }
}
