import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { PROTOCOL_VERSION, parseServerMessage } from '@dogfight/shared'
import { createServerApp, type ServerApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', (err) => reject(err))
  })
}

function waitUnexpectedResponse(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0)
    })
    ws.once('open', () => reject(new Error('Expected upgrade rejection')))
    ws.once('error', (err) => reject(err))
  })
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reasonBuf) => {
      resolve({ code, reason: reasonBuf.toString('utf8') })
    })
  })
}

function waitJsonMessage(
  ws: WebSocket,
  predicate: (msg: { type: string }) => boolean,
  timeoutMs = 4000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg)
      reject(new Error('Timed out waiting for WS JSON message'))
    }, timeoutMs)

    const onMsg = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) return
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
      const parsed = parseServerMessage(text)
      if (parsed.ok && predicate(parsed.value)) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve(parsed.value)
      }
    }
    ws.on('message', onMsg)
  })
}

describe('Lab 08 production hardening: endpoints, Origin, IP limits, shutdown, and fault tests', () => {
  const apps: ServerApp[] = []
  const tmpDirs: string[] = []

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop()
      if (app) await app.shutdown('test cleanup')
    }
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()
      if (dir) await rm(dir, { recursive: true, force: true })
    }
  })

  async function bootTestServer(
    envOverrides: Record<string, string> = {},
  ): Promise<{ app: ServerApp; httpUrl: string; wsUrl: string }> {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dogfight-lab8-'))
    tmpDirs.push(tmpDir)
    const config = loadConfig({
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_DIR: tmpDir,
      LOG_LEVEL: 'silent',
      GIT_SHA: 'abc1234',
      ALLOWED_ORIGINS: 'http://localhost:3000,https://dogfight.example',
      MAX_CONNECTIONS_PER_IP: '10',
      MAX_TOTAL_PLAYERS: '64',
      TRUST_PROXY: '1',
      ...envOverrides,
    })
    const app = createServerApp(config)
    apps.push(app)
    const { host, port } = await app.listen()
    return {
      app,
      httpUrl: `http://${host}:${port}`,
      wsUrl: `ws://${host}:${port}/ws`,
    }
  }

  it('serves /health (with gitSha), /ready (200 -> 503 on shutdown), and /metrics (Prometheus & JSON)', async () => {
    const { app, httpUrl } = await bootTestServer({ GIT_SHA: 'deadbeef' })

    const healthRes = await fetch(`${httpUrl}/health`)
    expect(healthRes.status).toBe(200)
    const healthJson: unknown = await healthRes.json()
    expect(healthJson).toMatchObject({ ok: true, gitSha: 'deadbeef' })

    const readyRes = await fetch(`${httpUrl}/ready`)
    expect(readyRes.status).toBe(200)
    const readyJson: unknown = await readyRes.json()
    expect(readyJson).toMatchObject({ ready: true })

    const promRes = await fetch(`${httpUrl}/metrics`)
    expect(promRes.status).toBe(200)
    const promText = await promRes.text()
    expect(promText).toContain('dogfight_players')
    expect(promText).toContain('dogfight_rooms')
    expect(promText).toContain('dogfight_messages_in_per_sec')
    expect(promText).toContain('dogfight_bytes_in_per_sec')
    expect(promText).toContain('dogfight_tick_duration_ms')
    expect(promText).toContain('dogfight_event_loop_utilization')
    expect(promText).toContain('dogfight_memory_rss_bytes')

    const jsonMetricsRes = await fetch(`${httpUrl}/metrics?format=json`)
    expect(jsonMetricsRes.status).toBe(200)
    const metricsObj: unknown = await jsonMetricsRes.json()
    expect(metricsObj).toMatchObject({
      players: 0,
      rooms: 3,
      wsConnections: 0,
    })

    await app.shutdown('test')
    expect(app.isReady()).toBe(false)
  })

  it('rejects disallowed Origin with 403 and accepts allowed Origin on WS handshake', async () => {
    const { wsUrl } = await bootTestServer()

    const evilWs = new WebSocket(wsUrl, {
      headers: { Origin: 'https://evil.attacker' },
    })
    const status = await waitUnexpectedResponse(evilWs)
    expect(status).toBe(403)

    const goodWs = new WebSocket(wsUrl, {
      headers: { Origin: 'https://dogfight.example' },
    })
    await waitOpen(goodWs)
    goodWs.close()
    await waitClose(goodWs)
  })

  it('enforces MAX_CONNECTIONS_PER_IP with 429 using X-Forwarded-For when TRUST_PROXY=1', async () => {
    const { wsUrl } = await bootTestServer({ MAX_CONNECTIONS_PER_IP: '2' })

    const ws1 = new WebSocket(wsUrl, {
      headers: { 'X-Forwarded-For': '203.0.113.5' },
    })
    const ws2 = new WebSocket(wsUrl, {
      headers: { 'X-Forwarded-For': '203.0.113.5' },
    })
    await Promise.all([waitOpen(ws1), waitOpen(ws2)])

    const ws3 = new WebSocket(wsUrl, {
      headers: { 'X-Forwarded-For': '203.0.113.5' },
    })
    const status = await waitUnexpectedResponse(ws3)
    expect(status).toBe(429)

    // Another IP is still allowed
    const wsOtherIp = new WebSocket(wsUrl, {
      headers: { 'X-Forwarded-For': '203.0.113.99' },
    })
    await waitOpen(wsOtherIp)

    ws1.close()
    ws2.close()
    wsOtherIp.close()
    await Promise.all([waitClose(ws1), waitClose(ws2), waitClose(wsOtherIp)])
  })

  it('graceful shutdown sends shutdown message and closes sockets with code 1001 in < 10s', async () => {
    const { app, wsUrl } = await bootTestServer()
    const ws = new WebSocket(wsUrl)
    await waitOpen(ws)

    ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'join',
        room: 'nebula-alpha',
        name: 'Graceful',
      }),
    )
    await waitJsonMessage(ws, (m) => m.type === 'welcome')

    const shutdownMsgPromise = waitJsonMessage(ws, (m) => m.type === 'shutdown')
    const closePromise = waitClose(ws)

    const t0 = performance.now()
    await app.shutdown('SIGTERM received')
    const elapsedMs = performance.now() - t0

    const shutdownMsg = await shutdownMsgPromise
    const closed = await closePromise

    expect(shutdownMsg.type).toBe('shutdown')
    expect(closed.code).toBe(1001)
    expect(elapsedMs).toBeLessThan(10_000)
  })

  it('fault test 1: abrupt client disconnect mid-match removes player cleanly while other player continues', async () => {
    const { wsUrl } = await bootTestServer()
    const wsA = new WebSocket(wsUrl)
    const wsB = new WebSocket(wsUrl)
    await Promise.all([waitOpen(wsA), waitOpen(wsB)])

    wsA.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'join',
        room: 'nebula-alpha',
        name: 'Dropper',
      }),
    )
    wsB.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'join',
        room: 'nebula-alpha',
        name: 'Survivor',
      }),
    )

    await Promise.all([
      waitJsonMessage(wsA, (m) => m.type === 'welcome'),
      waitJsonMessage(wsB, (m) => m.type === 'welcome'),
    ])

    const rosterAfterDrop = waitJsonMessage(
      wsB,
      (m) =>
        m.type === 'roster' &&
        'players' in m &&
        Array.isArray(m.players) &&
        m.players.length === 1,
    )

    // Abrupt network drop without clean close handshake
    wsA.terminate()

    const roster = await rosterAfterDrop
    expect(roster.type).toBe('roster')

    wsB.close()
    await waitClose(wsB)
  })

  it('fault test 2: flood of ~1000 corrupted frames/sec disconnects attacker without slowing other room', async () => {
    const { httpUrl, wsUrl } = await bootTestServer({
      RATE_LIMIT_PER_SEC: '60',
    })

    // Normal player in nebula-alpha
    const normalWs = new WebSocket(wsUrl)
    await waitOpen(normalWs)
    normalWs.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'join',
        room: 'nebula-alpha',
        name: 'CleanPilot',
      }),
    )
    await waitJsonMessage(normalWs, (m) => m.type === 'welcome')

    // Attacker blasts 1000 broken frames
    const attackerWs = new WebSocket(wsUrl)
    await waitOpen(attackerWs)
    const attackerClosed = waitClose(attackerWs)

    for (let i = 0; i < 1000; i += 1) {
      if (attackerWs.readyState !== WebSocket.OPEN) break
      if (i % 2 === 0) {
        attackerWs.send('{corrupt-json')
      } else {
        attackerWs.send(Buffer.from([0xff, 0x00, 0xde, 0xad]))
      }
    }

    const closeInfo = await attackerClosed
    expect([1007, 1008, 4008]).toContain(closeInfo.code)

    // Verify normal room ticks remained healthy (< 33.3 ms, 0 overruns)
    await new Promise((r) => setTimeout(r, 250))
    const statsRes = await fetch(`${httpUrl}/api/stats`)
    const stats: unknown = await statsRes.json()
    expect(typeof stats === 'object' && stats !== null).toBe(true)
    if (
      typeof stats === 'object' &&
      stats !== null &&
      'matches' in stats &&
      Array.isArray(stats.matches)
    ) {
      const match = stats.matches.find(
        (m: unknown) =>
          typeof m === 'object' &&
          m !== null &&
          'roomId' in m &&
          m.roomId === 'nebula-alpha',
      )
      expect(match).toBeDefined()
      if (
        typeof match === 'object' &&
        match !== null &&
        'overruns' in match &&
        'durationMs' in match &&
        typeof match.durationMs === 'object' &&
        match.durationMs !== null &&
        'p99' in match.durationMs &&
        typeof match.durationMs.p99 === 'number'
      ) {
        expect(match.overruns).toBe(0)
        expect(match.durationMs.p99).toBeLessThan(33.3)
      }
    }

    normalWs.close()
    await waitClose(normalWs)
  })

  it('loadConfig rejects invalid SHUTDOWN_TIMEOUT_MS > 9500 and empty ALLOWED_ORIGINS', () => {
    expect(() => loadConfig({ SHUTDOWN_TIMEOUT_MS: '15000' })).toThrow(
      /Invalid server config/,
    )
    expect(() => loadConfig({ ALLOWED_ORIGINS: ',,,' })).toThrow(
      /Invalid server config/,
    )
  })
})
