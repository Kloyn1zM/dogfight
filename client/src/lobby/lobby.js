import { fetchJson, HttpError, isAbortError } from '../assets/loader.js'

/**
 * Модель лобі поверх EventTarget, підключена до реального Node HTTP API (/api/rooms).
 */
export class Lobby extends EventTarget {
  #endpoint
  #rooms = []
  #pollTimer = 0
  #inFlight = null
  #visible = false

  constructor({ endpoint = '/api/rooms' } = {}) {
    super()
    this.#endpoint = endpoint
  }

  get rooms() {
    return this.#rooms
  }

  startPolling(intervalMs = 5000) {
    this.stopPolling()
    this.#visible = true
    this.refresh()
    this.#pollTimer = setInterval(() => {
      if (this.#visible) this.refresh()
    }, intervalMs)
  }

  stopPolling() {
    this.#visible = false
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = 0
    }
    if (this.#inFlight) {
      this.#inFlight.abort(new DOMException('Left lobby', 'AbortError'))
      this.#inFlight = null
    }
  }

  async refresh() {
    if (this.#inFlight) {
      this.#inFlight.abort(new DOMException('Superseded refresh', 'AbortError'))
    }
    const controller = new AbortController()
    this.#inFlight = controller

    this.dispatchEvent(
      new CustomEvent('loading', { detail: { loading: true } }),
    )

    try {
      const rooms = await fetchJson(this.#endpoint, {
        signal: controller.signal,
        timeoutMs: 4000,
      })
      if (!this.#visible) return
      this.#rooms = Array.isArray(rooms) ? rooms : []
      this.dispatchEvent(
        new CustomEvent('roomsChanged', { detail: { rooms: this.#rooms } }),
      )
    } catch (err) {
      if (isAbortError(err) && !this.#visible) return
      if (err?.name === 'AbortError') return
      this.dispatchEvent(
        new CustomEvent('error', { detail: { message: err.message } }),
      )
    } finally {
      if (this.#inFlight === controller) {
        this.#inFlight = null
      }
      this.dispatchEvent(
        new CustomEvent('loading', { detail: { loading: false } }),
      )
    }
  }

  async createRoom(name, difficulty = 'Normal') {
    const cleanName = String(name || '').trim()
    if (!cleanName) return null

    const res = await fetch(this.#endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cleanName, difficulty }),
      signal: AbortSignal.timeout(4000),
    })

    if (!res.ok) {
      let msg = res.statusText
      try {
        const body = await res.json()
        if (body?.error) msg = body.error
      } catch {
        // ігноруємо не-JSON тіло помилки
      }
      throw new HttpError(this.#endpoint, res.status, msg)
    }

    const created = await res.json()
    await this.refresh()
    return created
  }

  join(roomId, playerName) {
    const room = this.#rooms.find((r) => r.id === roomId) || this.#rooms[0]
    if (!room) return
    const cleanName = (playerName || '').trim() || 'Pilot'
    this.stopPolling()
    this.dispatchEvent(
      new CustomEvent('joined', {
        detail: { room, playerName: cleanName },
      }),
    )
  }
}
