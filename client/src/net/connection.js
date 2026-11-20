export const PROTOCOL_VERSION = 1

function defaultWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws`
}

/**
 * Обгортка над браузерним WebSocket:
 * - Диспатчить вхідні повідомлення як CustomEvent за їхнім `msg.type`.
 * - Тримає чергу відправки (`#queue`), поки сокет ще у стані CONNECTING.
 * - Автоматично перепідключається з експоненційним backoff + jitter
 *   та повторно надсилає `join` у ту саму кімнату.
 */
export class GameConnection extends EventTarget {
  #url
  #socket = null
  #queue = []
  #joinPayload = null
  #manualClose = false
  #reconnectTimer = 0
  #attempt = 0
  #status = 'closed'

  constructor({ url = defaultWsUrl() } = {}) {
    super()
    this.#url = url
  }

  get status() {
    return this.#status
  }

  connect({ room, name }) {
    this.disconnect()
    this.#manualClose = false
    this.#attempt = 0
    this.#joinPayload = { type: 'join', room, name }
    this.#openSocket()
  }

  disconnect() {
    this.#manualClose = true
    this.#joinPayload = null
    this.#queue.length = 0
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
    this.#setStatus('closed')
  }

  send(msg) {
    const encoded = JSON.stringify({ v: PROTOCOL_VERSION, ...msg })
    if (this.#socket && this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.send(encoded)
      return true
    }

    if (this.#queue.length >= 50) {
      this.#queue.shift()
    }
    this.#queue.push(encoded)
    return false
  }

  sendChat(text) {
    const clean = text.trim()
    if (!clean) return false
    return this.send({ type: 'chat', text: clean })
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
    this.#socket = socket

    socket.onopen = () => {
      if (this.#socket !== socket) return
      this.#attempt = 0
      this.#setStatus('open')

      if (this.#joinPayload) {
        socket.send(
          JSON.stringify({ v: PROTOCOL_VERSION, ...this.#joinPayload }),
        )
      }

      while (this.#queue.length > 0 && socket.readyState === WebSocket.OPEN) {
        socket.send(this.#queue.shift())
      }
    }

    socket.onmessage = (event) => {
      if (this.#socket !== socket) return
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (!msg || typeof msg.type !== 'string') return

      this.dispatchEvent(new CustomEvent('message', { detail: msg }))
      this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }))
    }

    socket.onerror = () => {
      // Деталі обриву надійдуть у onclose; тут уникаємо зайвого шуму
    }

    socket.onclose = (event) => {
      if (this.#socket !== socket) return
      this.#socket = null

      if (this.#manualClose) {
        this.#setStatus('closed', { code: event.code, reason: event.reason })
        return
      }

      // Не перепідключаємося при фатальних помилках клієнта (повна/неіснуюча кімната)
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
