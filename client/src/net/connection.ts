import {
  PROTOCOL_VERSION,
  TypedBus,
  assertNever,
  binaryCodec,
  jsonCodec,
  parseServerMessage,
  type ClientMessagePayload,
  type Codec,
  type CodecMode,
  type InputCommand,
  type ServerMessage,
  type Snapshot,
} from '@dogfight/shared'

export type ConnectionStatus = 'closed' | 'connecting' | 'reconnecting' | 'open'

export interface NetStats {
  readonly rttMs: number
  readonly bytesInPerSec: number
  readonly bytesOutPerSec: number
  readonly codec: CodecMode
}

export type ConnectionEvents = {
  status: {
    status: ConnectionStatus
    attempt?: number
    delayMs?: number
    code?: number
    reason?: string
  }
  welcome: Extract<ServerMessage, { type: 'welcome' }>
  roster: Extract<ServerMessage, { type: 'roster' }>
  chat: Extract<ServerMessage, { type: 'chat' }>
  system: Extract<ServerMessage, { type: 'system' }>
  events: Extract<ServerMessage, { type: 'events' }>
  error: Extract<ServerMessage, { type: 'error' }>
  shutdown: Extract<ServerMessage, { type: 'shutdown' }>
  fatalDisconnect: { reason: string; code?: number }
  codec: Extract<ServerMessage, { type: 'codec' }>
  netcfg: Extract<ServerMessage, { type: 'netcfg' }>
  snapshot: { snapshot: Snapshot; receivedAt: number }
  binarySnapshot: { data: ArrayBuffer; receivedAt: number }
}

function defaultWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws`
}

export class GameConnection {
  readonly events = new TypedBus<ConnectionEvents>()

  #url: string
  #socket: WebSocket | null = null
  #queue: string[] = []
  #joinPayload: {
    type: 'join'
    room: string
    name: string
    codec: CodecMode
  } | null = null
  #manualClose = false
  #reconnectTimer = 0
  #pingTimer = 0
  #bwTimer = 0
  #attempt = 0
  #maxReconnectAttempts = 3
  #serverShuttingDown = false
  #status: ConnectionStatus = 'closed'

  #codec: Codec = binaryCodec
  #rttMs = 0
  #bytesInAccum = 0
  #bytesOutAccum = 0
  #bytesInPerSec = 0
  #bytesOutPerSec = 0

  constructor({ url = defaultWsUrl() }: { url?: string } = {}) {
    this.#url = url
  }

  get status(): ConnectionStatus {
    return this.#status
  }

  get codecName(): CodecMode {
    return this.#codec.name
  }

  getNetStats(): NetStats {
    return {
      rttMs: this.#rttMs,
      bytesInPerSec: this.#bytesInPerSec,
      bytesOutPerSec: this.#bytesOutPerSec,
      codec: this.#codec.name,
    }
  }

  connect({
    room,
    name,
    codec = 'binary',
  }: {
    room: string
    name: string
    codec?: CodecMode
  }): void {
    this.disconnect()
    this.#manualClose = false
    this.#serverShuttingDown = false
    this.#attempt = 0
    this.#codec = codec === 'json' ? jsonCodec : binaryCodec
    this.#joinPayload = { type: 'join', room, name, codec: this.#codec.name }
    this.#startTimers()
    this.#openSocket()
  }

  disconnect(): void {
    this.#manualClose = true
    this.#joinPayload = null
    this.#queue.length = 0
    this.#stopTimers()
    if (this.#reconnectTimer) {
      window.clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = 0
    }
    if (this.#socket) {
      const sock = this.#socket
      this.#socket = null
      sock.onopen = null
      sock.onmessage = null
      sock.onerror = null
      sock.onclose = null
      if (
        sock.readyState === WebSocket.OPEN ||
        sock.readyState === WebSocket.CONNECTING
      ) {
        sock.close(1000, 'Client left room')
      }
    }
    this.#bytesInAccum = 0
    this.#bytesOutAccum = 0
    this.#bytesInPerSec = 0
    this.#bytesOutPerSec = 0
    this.#rttMs = 0
    this.#setStatus('closed')
  }

  setCodec(mode: CodecMode): void {
    this.#codec = mode === 'json' ? jsonCodec : binaryCodec
    if (this.#joinPayload) {
      this.#joinPayload.codec = this.#codec.name
    }
    this.send({ type: 'codec', mode: this.#codec.name })
  }

  setNetConfig({
    rttMs,
    jitterMs,
    dropRate,
  }: {
    rttMs: number
    jitterMs: number
    dropRate: number
  }): void {
    this.send({ type: 'netcfg', rttMs, jitterMs, dropRate })
  }

  send(msg: ClientMessagePayload): boolean {
    const encoded = JSON.stringify({ v: PROTOCOL_VERSION, ...msg })
    if (this.#socket && this.#socket.readyState === WebSocket.OPEN) {
      this.#bytesOutAccum += encoded.length
      this.#socket.send(encoded)
      return true
    }

    if (this.#queue.length >= 50) {
      this.#queue.shift()
    }
    this.#queue.push(encoded)
    return false
  }

  sendInput(input: InputCommand): boolean {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      return false
    }
    const payload = this.#codec.encodeInput(input)
    this.#bytesOutAccum +=
      typeof payload === 'string' ? payload.length : payload.byteLength
    this.#socket.send(payload)
    return true
  }

  sendChat(text: string): boolean {
    const clean = text.trim()
    if (!clean) return false
    return this.send({ type: 'chat', text: clean })
  }

  #startTimers(): void {
    this.#stopTimers()
    this.#pingTimer = window.setInterval(() => {
      if (this.#socket && this.#socket.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping', t: performance.now() })
      }
    }, 1000)

    this.#bwTimer = window.setInterval(() => {
      this.#bytesInPerSec = this.#bytesInAccum
      this.#bytesOutPerSec = this.#bytesOutAccum
      this.#bytesInAccum = 0
      this.#bytesOutAccum = 0
    }, 1000)
  }

  #stopTimers(): void {
    if (this.#pingTimer) {
      window.clearInterval(this.#pingTimer)
      this.#pingTimer = 0
    }
    if (this.#bwTimer) {
      window.clearInterval(this.#bwTimer)
      this.#bwTimer = 0
    }
  }

  #setStatus(
    next: ConnectionStatus,
    detail: Omit<ConnectionEvents['status'], 'status'> = {},
  ): void {
    this.#status = next
    this.events.emit('status', { status: next, ...detail })
  }

  #openSocket(): void {
    this.#setStatus(this.#attempt === 0 ? 'connecting' : 'reconnecting', {
      attempt: this.#attempt,
    })

    const socket = new WebSocket(this.#url)
    socket.binaryType = 'arraybuffer'
    this.#socket = socket

    socket.onopen = () => {
      if (this.#socket !== socket) return
      this.#attempt = 0
      this.#setStatus('open')

      if (this.#joinPayload) {
        const joinStr = JSON.stringify({
          v: PROTOCOL_VERSION,
          ...this.#joinPayload,
        })
        this.#bytesOutAccum += joinStr.length
        socket.send(joinStr)
      }

      while (this.#queue.length > 0 && socket.readyState === WebSocket.OPEN) {
        const item = this.#queue.shift()
        if (item !== undefined) {
          this.#bytesOutAccum += item.length
          socket.send(item)
        }
      }

      this.send({ type: 'ping', t: performance.now() })
    }

    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (this.#socket !== socket) return
      const now = performance.now()

      if (event.data instanceof ArrayBuffer) {
        this.#bytesInAccum += event.data.byteLength
        this.events.emit('binarySnapshot', {
          data: event.data,
          receivedAt: now,
        })
        return
      }

      if (typeof event.data !== 'string') return
      this.#bytesInAccum += event.data.length

      const parsed = parseServerMessage(event.data)
      if (!parsed.ok) {
        console.warn('[WS] invalid server message:', parsed.reason)
        return
      }

      const msg = parsed.value
      switch (msg.type) {
        case 'pong': {
          const sample = Math.max(0, now - msg.t)
          this.#rttMs =
            this.#rttMs === 0 ? sample : this.#rttMs * 0.7 + sample * 0.3
          return
        }
        case 'snapshot': {
          const snapshot: Snapshot = {
            tick: msg.tick,
            lastProcessedSeq: msg.lastProcessedSeq,
            matchTimeMs: msg.matchTimeMs,
            entities: msg.entities,
          }
          this.events.emit('snapshot', { snapshot, receivedAt: now })
          return
        }
        case 'welcome':
          this.events.emit('welcome', msg)
          return
        case 'roster':
          this.events.emit('roster', msg)
          return
        case 'chat':
          this.events.emit('chat', msg)
          return
        case 'system':
          this.events.emit('system', msg)
          return
        case 'events':
          this.events.emit('events', msg)
          return
        case 'error':
          this.events.emit('error', msg)
          return
        case 'shutdown':
          this.#serverShuttingDown = true
          this.events.emit('shutdown', msg)
          this.events.emit('fatalDisconnect', {
            reason: msg.reason,
            code: 1001,
          })
          return
        case 'codec':
          this.events.emit('codec', msg)
          return
        case 'netcfg':
          this.events.emit('netcfg', msg)
          return
        default:
          assertNever(msg)
      }
    }

    socket.onerror = () => {
      // Деталі закриття надійдуть у onclose
    }

    socket.onclose = (event) => {
      if (this.#socket !== socket) return
      this.#socket = null

      if (
        this.#manualClose ||
        this.#serverShuttingDown ||
        event.code === 4003 ||
        event.code === 4004
      ) {
        this.#setStatus('closed', { code: event.code, reason: event.reason })
        if (!this.#manualClose && !this.#serverShuttingDown) {
          this.events.emit('fatalDisconnect', {
            reason: event.reason || `З'єднання закрито (${event.code})`,
            code: event.code,
          })
        }
        return
      }

      if (this.#attempt >= this.#maxReconnectAttempts) {
        this.#setStatus('closed', { code: event.code, reason: event.reason })
        this.events.emit('fatalDisconnect', {
          reason: 'Сервер недоступний — повернення в лобі',
          code: event.code,
        })
        return
      }

      this.#scheduleReconnect(event)
    }
  }

  #scheduleReconnect(event: CloseEvent): void {
    this.#attempt += 1
    const baseMs = Math.min(8000, 500 * 2 ** (this.#attempt - 1))
    const delayMs = Math.round(baseMs + Math.random() * 300)

    this.#setStatus('reconnecting', {
      attempt: this.#attempt,
      delayMs,
      code: event.code,
      reason: event.reason,
    })

    this.#reconnectTimer = window.setTimeout(() => {
      this.#reconnectTimer = 0
      if (!this.#manualClose) this.#openSocket()
    }, delayMs)
  }
}
