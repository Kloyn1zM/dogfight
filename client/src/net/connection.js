import { PROTOCOL_VERSION, binaryCodec, jsonCodec } from '@dogfight/shared'

export { PROTOCOL_VERSION }

function defaultWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws`
}

export class GameConnection extends EventTarget {
  #url
  #socket = null
  #queue = []
  #joinPayload = null
  #manualClose = false
  #reconnectTimer = 0
  #pingTimer = 0
  #bwTimer = 0
  #attempt = 0
  #status = 'closed'

  #codec = binaryCodec
  #rttMs = 0
  #bytesInAccum = 0
  #bytesOutAccum = 0
  #bytesInPerSec = 0
  #bytesOutPerSec = 0

  constructor({ url = defaultWsUrl() } = {}) {
    super()
    this.#url = url
  }

  get status() {
    return this.#status
  }

  get codecName() {
    return this.#codec.name
  }

  getNetStats() {
    return {
      rttMs: this.#rttMs,
      bytesInPerSec: this.#bytesInPerSec,
      bytesOutPerSec: this.#bytesOutPerSec,
      codec: this.#codec.name,
    }
  }

  connect({ room, name, codec = 'binary' }) {
    this.disconnect()
    this.#manualClose = false
    this.#attempt = 0
    this.#codec = codec === 'json' ? jsonCodec : binaryCodec
    this.#joinPayload = { type: 'join', room, name, codec: this.#codec.name }
    this.#startTimers()
    this.#openSocket()
  }

  disconnect() {
    this.#manualClose = true
    this.#joinPayload = null
    this.#queue.length = 0
    this.#stopTimers()
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
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

  setCodec(mode) {
    this.#codec = mode === 'json' ? jsonCodec : binaryCodec
    if (this.#joinPayload) {
      this.#joinPayload.codec = this.#codec.name
    }
    this.send({ type: 'codec', mode: this.#codec.name })
  }

  setNetConfig({ rttMs, jitterMs, dropRate }) {
    this.send({ type: 'netcfg', rttMs, jitterMs, dropRate })
  }

  send(msg) {
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

  sendInput(input) {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      return false
    }
    const payload = this.#codec.encodeInput(input)
    this.#bytesOutAccum +=
      typeof payload === 'string' ? payload.length : payload.byteLength
    this.#socket.send(payload)
    return true
  }

  sendChat(text) {
    const clean = text.trim()
    if (!clean) return false
    return this.send({ type: 'chat', text: clean })
  }

  #startTimers() {
    this.#stopTimers()
    this.#pingTimer = setInterval(() => {
      if (this.#socket && this.#socket.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping', t: performance.now() })
      }
    }, 1000)

    this.#bwTimer = setInterval(() => {
      this.#bytesInPerSec = this.#bytesInAccum
      this.#bytesOutPerSec = this.#bytesOutAccum
      this.#bytesInAccum = 0
      this.#bytesOutAccum = 0
    }, 1000)
  }

  #stopTimers() {
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer)
      this.#pingTimer = 0
    }
    if (this.#bwTimer) {
      clearInterval(this.#bwTimer)
      this.#bwTimer = 0
    }
  }

  #setStatus(next, detail = {}) {
    this.#status = next
    this.dispatchEvent(
      new CustomEvent('status', { detail: { status: next, ...detail } }),
    )
  }

  #openSocket() {
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
        this.#bytesOutAccum += item.length
        socket.send(item)
      }

      this.send({ type: 'ping', t: performance.now() })
    }

    socket.onmessage = (event) => {
      if (this.#socket !== socket) return
      const now = performance.now()

      // Бінарний фрейм: снапшот світу (DataView)
      if (event.data instanceof ArrayBuffer) {
        this.#bytesInAccum += event.data.byteLength
        try {
          const snapshot = binaryCodec.decodeSnapshot(event.data)
          this.dispatchEvent(
            new CustomEvent('snapshot', {
              detail: { snapshot, receivedAt: now },
            }),
          )
        } catch (err) {
          console.warn('[WS] failed to decode binary snapshot:', err.message)
        }
        return
      }

      if (typeof event.data !== 'string') return
      this.#bytesInAccum += event.data.length

      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (!msg || typeof msg.type !== 'string') return

      if (msg.type === 'pong' && typeof msg.t === 'number') {
        const sample = Math.max(0, now - msg.t)
        this.#rttMs =
          this.#rttMs === 0 ? sample : this.#rttMs * 0.7 + sample * 0.3
        return
      }

      if (msg.type === 'snapshot') {
        try {
          const snapshot = jsonCodec.decodeSnapshot(msg)
          this.dispatchEvent(
            new CustomEvent('snapshot', {
              detail: { snapshot, receivedAt: now },
            }),
          )
        } catch (err) {
          console.warn('[WS] failed to decode JSON snapshot:', err.message)
        }
        return
      }

      this.dispatchEvent(new CustomEvent('message', { detail: msg }))
      this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }))
    }

    socket.onerror = () => {
      // Обробка закриття виконується в onclose
    }

    socket.onclose = (event) => {
      if (this.#socket !== socket) return
      this.#socket = null

      if (this.#manualClose) {
        this.#setStatus('closed', { code: event.code, reason: event.reason })
        return
      }

      if (event.code === 4003 || event.code === 4004) {
        this.#setStatus('closed', { code: event.code, reason: event.reason })
        return
      }

      this.#scheduleReconnect(event)
    }
  }

  #scheduleReconnect(event) {
    this.#attempt += 1
    const baseMs = Math.min(8000, 500 * 2 ** (this.#attempt - 1))
    const delayMs = Math.round(baseMs + Math.random() * 300)

    this.#setStatus('reconnecting', {
      attempt: this.#attempt,
      delayMs,
      code: event.code,
      reason: event.reason,
    })

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = 0
      if (!this.#manualClose) this.#openSocket()
    }, delayMs)
  }
}
