import { WebSocket, type RawData } from 'ws'
import {
  PROTOCOL_VERSION,
  TICK_MS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  asSeq,
  asTick,
  binaryCodec,
  encodeJsonMessage,
  parseServerMessage,
  shortestAngleDiff,
  type EntityId,
  type InputCommand,
  type ShipSnapshot,
  type Snapshot,
  type TurnDirection,
} from '@dogfight/shared'

export interface BotClientOptions {
  readonly url: string
  readonly room: string
  readonly name: string
  readonly fireEnabled?: boolean
  readonly thinkIntervalMs?: number
}

export interface BotStats {
  readonly name: string
  readonly joined: boolean
  readonly connected: boolean
  readonly snapshotsReceived: number
  readonly inputsSent: number
}

function rawDataToArrayBuffer(data: RawData): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data
  const merged = Buffer.isBuffer(data) ? data : Buffer.concat(data)
  const out = new Uint8Array(merged.byteLength)
  out.set(merged)
  return out.buffer
}

function wrapDelta(delta: number, size: number): number {
  let d = delta
  if (d > size / 2) d -= size
  else if (d < -size / 2) d += size
  return d
}

export class BotClient {
  readonly #url: string
  readonly #room: string
  readonly #name: string
  readonly #fireEnabled: boolean
  readonly #thinkIntervalMs: number

  #socket: WebSocket | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #running = false
  #joined = false
  #myShipId: EntityId | null = null
  #latestSnapshot: Snapshot | null = null
  #seq = 1
  #snapshotsReceived = 0
  #inputsSent = 0
  #homingCounter = 0

  #joinResolve: (() => void) | null = null
  #joinReject: ((err: Error) => void) | null = null

  constructor(options: BotClientOptions) {
    this.#url = options.url
    this.#room = options.room
    this.#name = options.name
    this.#fireEnabled = options.fireEnabled ?? true
    this.#thinkIntervalMs = options.thinkIntervalMs ?? TICK_MS
  }

  getStats(): BotStats {
    return {
      name: this.#name,
      joined: this.#joined,
      connected: this.#socket?.readyState === WebSocket.OPEN,
      snapshotsReceived: this.#snapshotsReceived,
      inputsSent: this.#inputsSent,
    }
  }

  connect(): Promise<void> {
    if (this.#running) return Promise.resolve()
    this.#running = true

    return new Promise<void>((resolve, reject) => {
      this.#joinResolve = resolve
      this.#joinReject = reject

      const socket = new WebSocket(this.#url)
      this.#socket = socket

      socket.on('open', () => {
        const joinPayload = encodeJsonMessage({
          type: 'join',
          room: this.#room,
          name: this.#name,
          codec: 'binary',
        })
        socket.send(joinPayload)
      })

      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          try {
            this.#latestSnapshot = binaryCodec.decodeSnapshot(
              rawDataToArrayBuffer(data),
            )
            this.#snapshotsReceived += 1
          } catch {
            // ignore malformed frames in bot client
          }
          return
        }

        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
        const parsed = parseServerMessage(text)
        if (!parsed.ok) return

        if (parsed.value.type === 'welcome') {
          this.#myShipId = parsed.value.shipId
          this.#joined = true
          this.#startInputLoop()
          this.#joinResolve?.()
          this.#joinResolve = null
          this.#joinReject = null
        } else if (parsed.value.type === 'error' && !this.#joined) {
          this.#joinReject?.(
            new Error(`Bot "${this.#name}" rejected: ${parsed.value.reason}`),
          )
          this.#joinResolve = null
          this.#joinReject = null
        }
      })

      socket.on('error', (err) => {
        if (!this.#joined) {
          this.#joinReject?.(err)
          this.#joinResolve = null
          this.#joinReject = null
        }
      })

      socket.on('close', (code, reasonBuf) => {
        this.#stopInputLoop()
        if (!this.#joined && this.#joinReject) {
          const reason = reasonBuf.toString('utf8') || `code ${code}`
          this.#joinReject(
            new Error(`Bot "${this.#name}" closed before join: ${reason}`),
          )
          this.#joinResolve = null
          this.#joinReject = null
        }
      })
    })
  }

  disconnect(): void {
    this.#running = false
    this.#stopInputLoop()
    if (this.#socket) {
      const sock = this.#socket
      this.#socket = null
      if (
        sock.readyState === WebSocket.OPEN ||
        sock.readyState === WebSocket.CONNECTING
      ) {
        sock.close(1000, 'Bot shutdown')
      }
    }
  }

  #startInputLoop(): void {
    this.#stopInputLoop()
    let nextAt = performance.now() + this.#thinkIntervalMs

    const step = () => {
      if (!this.#running) return
      if (this.#socket?.readyState === WebSocket.OPEN) {
        const cmd = this.#decideInput()
        const frame = binaryCodec.encodeInput(cmd)
        this.#socket.send(frame)
        this.#inputsSent += 1
      }
      nextAt += this.#thinkIntervalMs
      const now = performance.now()
      if (nextAt < now - 250) nextAt = now + this.#thinkIntervalMs
      const delay = Math.max(1, nextAt - now)
      this.#timer = setTimeout(step, delay)
    }

    this.#timer = setTimeout(step, this.#thinkIntervalMs)
  }

  #stopInputLoop(): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  #decideInput(): InputCommand {
    const snap = this.#latestSnapshot
    const myShipId = this.#myShipId
    const tick = snap ? snap.tick : asTick(0)

    let turn: TurnDirection = 0
    let thrust = true
    let fire = false
    let fireHoming = false

    if (snap && myShipId !== null) {
      let me: ShipSnapshot | null = null
      for (const e of snap.entities) {
        if (e.kind === 'ship' && e.id === myShipId) {
          me = e
          break
        }
      }

      if (me && me.alive) {
        let bestDx = 0
        let bestDy = 0
        let bestDistSq = Infinity
        let targetIsShip = false

        for (const e of snap.entities) {
          if (e.kind === 'ship') {
            if (!e.alive || e.id === myShipId) continue
            const dx = wrapDelta(e.x - me.x, WORLD_WIDTH)
            const dy = wrapDelta(e.y - me.y, WORLD_HEIGHT)
            const dSq = dx * dx + dy * dy
            if (dSq < bestDistSq) {
              bestDistSq = dSq
              bestDx = dx
              bestDy = dy
              targetIsShip = true
            }
          } else if (e.kind === 'asteroid') {
            const dx = wrapDelta(e.x - me.x, WORLD_WIDTH)
            const dy = wrapDelta(e.y - me.y, WORLD_HEIGHT)
            const dSq = dx * dx + dy * dy
            if (dSq < bestDistSq) {
              bestDistSq = dSq
              bestDx = dx
              bestDy = dy
              targetIsShip = false
            }
          }
        }

        if (bestDistSq < Infinity) {
          const desired = Math.atan2(bestDy, bestDx)
          const diff = shortestAngleDiff(me.angle, desired)
          turn = diff > 0.1 ? 1 : diff < -0.1 ? -1 : 0
          thrust = bestDistSq > 130 * 130
          if (this.#fireEnabled && Math.abs(diff) < 0.35) {
            fire = true
            this.#homingCounter += 1
            if (targetIsShip && this.#homingCounter % 25 === 0) {
              fireHoming = true
            }
          }
        }
      }
    }

    return {
      seq: asSeq(this.#seq++),
      tick,
      turn,
      thrust,
      fire,
      fireHoming,
    }
  }
}

export { PROTOCOL_VERSION }
