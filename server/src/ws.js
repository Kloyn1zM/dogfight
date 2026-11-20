import { WebSocket, WebSocketServer } from 'ws'
import {
  encodeMessage,
  makeChat,
  makeError,
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

export function attachWebSocketServer(httpServer, { roomManager, config }) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: config.maxPayloadBytes,
  })

  let nextPlayerId = 1
  const socketMeta = new Map()
  let droppedSlowMessages = 0

  wss.on('error', (err) => {
    console.error('[WSS] server error:', err.message)
  })

  function safeSend(socket, payload, { critical = false } = {}) {
    if (socket.readyState !== WebSocket.OPEN) return false

    // Slow-client policy: не даємо повільному клієнту залити RAM сервера
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

    socket.send(payload)
    return true
  }

  function broadcastRoom(room, payload, { critical = false } = {}) {
    for (const player of room.players.values()) {
      safeSend(player.socket, payload, { critical })
    }
  }

  // Heartbeat: пінг кожні 15 с, розрив після 2 пропущених pong
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

    // Обов'язковий слухач 'error' на кожному сокеті
    socket.on('error', (err) => {
      console.error('[WS] socket error:', err.message)
    })

    socket.on('pong', () => {
      meta.missedPongs = 0
    })

    socket.on('message', (data, isBinary) => {
      if (!meta.bucket.take(1)) {
        safeSend(socket, makeError('Rate limit exceeded'), { critical: true })
        socket.close(4008, 'Rate limit exceeded')
        return
      }

      if (isBinary) {
        safeSend(socket, makeError('Binary frames not supported in v1'), {
          critical: true,
        })
        socket.close(1003, 'Text JSON expected in v1')
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
        safeSend(socket, encodeMessage({ type: 'pong', t: msg.t }))
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

        const player = {
          id: `p${nextPlayerId++}`,
          name: msg.name,
          socket,
          joinedAt: Date.now(),
        }

        if (!room.join(player)) {
          safeSend(socket, makeError('Room is full'), { critical: true })
          socket.close(4003, 'Room full')
          return
        }

        clearTimeout(meta.joinTimer)
        meta.joinTimer = null
        meta.player = player
        meta.room = room

        safeSend(socket, makeWelcome(player, room), { critical: true })
        broadcastRoom(room, makeRoster(room), { critical: true })
        broadcastRoom(room, makeSystem(`${player.name} приєднався до кімнати`))
        return
      }

      if (!meta.player || !meta.room) {
        safeSend(socket, makeError('Send join first'), { critical: true })
        socket.close(4002, 'Not joined')
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
    getStats() {
      return {
        connections: socketMeta.size,
        droppedSlowMessages,
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
