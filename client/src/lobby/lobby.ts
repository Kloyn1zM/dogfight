import {
  RoomPublicInfoSchema,
  TypedBus,
  type Difficulty,
  type RoomPublicInfo,
} from '@dogfight/shared'
import {
  HttpError,
  fetchJson,
  getErrorMessage,
  getErrorName,
  isAbortError,
} from '../assets/loader.ts'

export type LobbyEvents = {
  loading: { loading: boolean }
  roomsChanged: { rooms: readonly RoomPublicInfo[] }
  error: { message: string }
  joined: { room: RoomPublicInfo; playerName: string }
}

const RoomsListSchema = RoomPublicInfoSchema.array()

export class Lobby {
  readonly events = new TypedBus<LobbyEvents>()

  #endpoint: string
  #rooms: RoomPublicInfo[] = []
  #pollTimer = 0
  #inFlight: AbortController | null = null
  #visible = false

  constructor({ endpoint = '/api/rooms' }: { endpoint?: string } = {}) {
    this.#endpoint = endpoint
  }

  get rooms(): readonly RoomPublicInfo[] {
    return this.#rooms
  }

  startPolling(intervalMs = 5000): void {
    this.stopPolling()
    this.#visible = true
    void this.refresh()
    this.#pollTimer = window.setInterval(() => {
      if (this.#visible) void this.refresh()
    }, intervalMs)
  }

  stopPolling(): void {
    this.#visible = false
    if (this.#pollTimer) {
      window.clearInterval(this.#pollTimer)
      this.#pollTimer = 0
    }
    if (this.#inFlight) {
      this.#inFlight.abort(new DOMException('Left lobby', 'AbortError'))
      this.#inFlight = null
    }
  }

  async refresh(): Promise<void> {
    if (this.#inFlight) {
      this.#inFlight.abort(new DOMException('Superseded refresh', 'AbortError'))
    }
    const controller = new AbortController()
    this.#inFlight = controller

    this.events.emit('loading', { loading: true })

    try {
      const raw = await fetchJson(this.#endpoint, {
        signal: controller.signal,
        timeoutMs: 4000,
      })
      if (!this.#visible) return
      const parsed = RoomsListSchema.safeParse(raw)
      if (!parsed.success) {
        throw new Error('Unexpected rooms response shape')
      }
      this.#rooms = parsed.data
      this.events.emit('roomsChanged', { rooms: this.#rooms })
    } catch (err: unknown) {
      if (isAbortError(err) && !this.#visible) return
      if (getErrorName(err) === 'AbortError') return
      this.events.emit('error', { message: getErrorMessage(err) })
    } finally {
      if (this.#inFlight === controller) {
        this.#inFlight = null
      }
      this.events.emit('loading', { loading: false })
    }
  }

  async createRoom(
    name: string,
    difficulty: Difficulty = 'Normal',
  ): Promise<RoomPublicInfo | null> {
    const cleanName = name.trim()
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
        const body: unknown = await res.json()
        if (
          typeof body === 'object' &&
          body !== null &&
          'error' in body &&
          typeof body.error === 'string'
        ) {
          msg = body.error
        }
      } catch {
        // ігноруємо не-JSON тіло помилки
      }
      throw new HttpError(this.#endpoint, res.status, msg)
    }

    const raw: unknown = await res.json()
    const parsed = RoomPublicInfoSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error('Invalid room object returned by server')
    }

    await this.refresh()
    return parsed.data
  }

  join(roomId: string, playerName: string): void {
    const room = this.#rooms.find((r) => r.id === roomId) ?? this.#rooms[0]
    if (!room) return
    const cleanName = playerName.trim() || 'Pilot'
    this.stopPolling()
    this.events.emit('joined', { room, playerName: cleanName })
  }
}
