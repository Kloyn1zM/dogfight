import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@dogfight/shared'
import { GameConnection } from '../src/net/connection.ts'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  binaryType = 'blob'
  readyState = FakeWebSocket.CONNECTING
  sent: Array<string | ArrayBuffer> = []

  onopen: (() => void) | null = null
  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }

  close(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason })
  }

  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  triggerText(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  triggerDrop(code = 1006, reason = 'Abnormal closure'): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason })
  }
}

describe('GameConnection fault handling (shutdown & dead server -> return to lobby)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: '127.0.0.1:3000' },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('emits shutdown and fatalDisconnect when server sends shutdown message', () => {
    const conn = new GameConnection({ url: 'ws://127.0.0.1:3000/ws' })
    const shutdownSpy = vi.fn()
    const fatalSpy = vi.fn()
    conn.events.on('shutdown', shutdownSpy)
    conn.events.on('fatalDisconnect', fatalSpy)

    conn.connect({ room: 'nebula-alpha', name: 'Ace' })
    const ws = FakeWebSocket.instances[0]
    expect(ws).toBeDefined()
    ws?.triggerOpen()
    ws?.triggerText(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'shutdown',
        reason: 'Server shutting down (SIGTERM)',
      }),
    )
    ws?.triggerDrop(1001, 'Server shutting down')

    expect(shutdownSpy).toHaveBeenCalledTimes(1)
    expect(fatalSpy).toHaveBeenCalledWith({
      reason: 'Server shutting down (SIGTERM)',
      code: 1001,
    })

    // Must not keep reconnecting after explicit server shutdown
    vi.advanceTimersByTime(10_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    conn.disconnect()
  })

  it('returns to lobby (fatalDisconnect) after 3 failed reconnects when server is killed', () => {
    const conn = new GameConnection({ url: 'ws://127.0.0.1:3000/ws' })
    const fatalSpy = vi.fn()
    conn.events.on('fatalDisconnect', fatalSpy)

    conn.connect({ room: 'nebula-alpha', name: 'Ace' })
    FakeWebSocket.instances[0]?.triggerOpen()
    FakeWebSocket.instances[0]?.triggerDrop(1006, 'Server killed')

    // 3 reconnect attempts fail while server stays dead
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      vi.advanceTimersByTime(10_000)
      const latest = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
      expect(latest).toBeDefined()
      latest?.triggerDrop(1006, 'Connection refused')
    }

    expect(fatalSpy).toHaveBeenCalledTimes(1)
    expect(conn.status).toBe('closed')
    conn.disconnect()
  })
})
