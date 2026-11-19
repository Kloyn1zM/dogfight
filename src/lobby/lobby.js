import { fetchJson, isAbortError } from '../assets/loader.js'

/**
 * Модель лобі поверх EventTarget.
 * - Періодично опитує HTTP /api/rooms.json з таймаутом AbortSignal.timeout.
 * - При виході з лобі (stopPolling / join) скасовує активний запит через AbortController,
 *   щоб відповідь «з того світу» не оновила закритий екран.
 * - Не має жодної прив'язки до DOM — рендер живе окремо в lobbyView.js.
 */
export class Lobby extends EventTarget {
  #endpoint
  #rooms = []
  #pollTimer = 0
  #inFlight = null
  #visible = false

  constructor({ endpoint = '/api/rooms.json' } = {}) {
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
