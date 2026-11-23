import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { loadConfig } from './config.ts'
import { RoomManager } from './rooms.ts'
import { attachWebSocketServer, type WsControl } from './ws.ts'
import { listReplays, streamReplayToResponse } from './log/replay.ts'

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
}

const MAX_JSON_BODY_BYTES = 4096

const CreateRoomBodySchema = z.object({
  name: z.string().trim().min(1, 'Field "name" is required').max(28),
  difficulty: z.enum(['Normal', 'Hard', 'Chill']).default('Normal'),
})

class HttpStatusError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

function getErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = err.code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buf.length
    if (total > maxBytes) {
      throw new HttpStatusError(413, 'Request body too large')
    }
    chunks.push(buf)
  }

  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed
  } catch {
    throw new HttpStatusError(400, 'Malformed JSON body')
  }
}

async function serveStatic(
  distDir: string,
  pathname: string,
  res: ServerResponse,
): Promise<void> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    sendJson(res, 400, { error: 'Invalid URL encoding' })
    return
  }

  const relPath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const candidate = path.resolve(distDir, relPath)
  if (candidate !== distDir && !candidate.startsWith(distDir + path.sep)) {
    sendJson(res, 403, { error: 'Forbidden' })
    return
  }

  let filePath = candidate
  let info
  try {
    info = await stat(filePath)
    if (info.isDirectory()) {
      filePath = path.join(filePath, 'index.html')
      info = await stat(filePath)
    }
  } catch {
    sendJson(res, 404, {
      error: 'Not found (run npm run build for static dist)',
    })
    return
  }

  const ext = path.extname(filePath).toLowerCase()
  const mime = MIME_TYPES[ext] ?? 'application/octet-stream'

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': String(info.size),
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  })

  try {
    await pipeline(createReadStream(filePath), res)
  } catch (err: unknown) {
    if (
      getErrorCode(err) !== 'ERR_STREAM_PREMATURE_CLOSE' &&
      !res.writableEnded
    ) {
      res.destroy(err instanceof Error ? err : new Error(String(err)))
    }
  }
}

const config = loadConfig()
const roomManager = new RoomManager({
  maxRooms: config.maxRooms,
  maxPlayersPerRoom: config.maxPlayersPerRoom,
  logDir: config.logDir,
})
roomManager.seedDefaults()

let wsControl: WsControl | null = null

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    )
    const { pathname } = url

    if (req.method === 'GET' && pathname === '/health') {
      const mem = process.memoryUsage()
      sendJson(res, 200, {
        ok: true,
        uptimeSec: Number(process.uptime().toFixed(1)),
        rooms: roomManager.size,
        players: roomManager.totalPlayers(),
        rssMb: Number((mem.rss / (1024 * 1024)).toFixed(2)),
        heapUsedMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
        ws: wsControl ? wsControl.getStats() : null,
      })
      return
    }

    if (req.method === 'GET' && pathname === '/api/stats') {
      const mem = process.memoryUsage()
      const matches = roomManager
        .allRooms()
        .flatMap((r) => (r.match ? [r.match.getStats()] : []))
      sendJson(res, 200, {
        uptimeSec: Number(process.uptime().toFixed(1)),
        rssMb: Number((mem.rss / (1024 * 1024)).toFixed(2)),
        heapUsedMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
        rooms: roomManager.size,
        players: roomManager.totalPlayers(),
        ws: wsControl ? wsControl.getStats() : null,
        matches,
      })
      return
    }

    if (req.method === 'GET' && pathname === '/api/rooms') {
      sendJson(res, 200, roomManager.list())
      return
    }

    if (req.method === 'POST' && pathname === '/api/rooms') {
      const rawBody = await readJsonBody(req)
      const parsed = CreateRoomBodySchema.safeParse(rawBody)
      if (!parsed.success) {
        const msg = parsed.error.issues[0]?.message ?? 'Invalid room payload'
        sendJson(res, 400, { error: msg })
        return
      }
      try {
        const room = roomManager.create({
          name: parsed.data.name,
          difficulty: parsed.data.difficulty,
          persistent: false,
        })
        sendJson(res, 201, room.toPublicInfo())
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        sendJson(res, 400, { error: msg })
      }
      return
    }

    if (req.method === 'GET' && pathname === '/api/replays') {
      const items = await listReplays(config.logDir)
      sendJson(res, 200, items)
      return
    }

    if (req.method === 'GET' && pathname.startsWith('/api/replays/')) {
      const replayId = pathname.slice('/api/replays/'.length)
      await streamReplayToResponse(config.logDir, replayId, res)
      return
    }

    if (
      req.method === 'GET' &&
      pathname === '/api/slow' &&
      config.enableSlowDemo
    ) {
      const ms = Math.min(
        1000,
        Math.max(10, Number(url.searchParams.get('ms') ?? 300)),
      )
      const start = performance.now()
      while (performance.now() - start < ms) {
        // навмисно блокуємо єдиний потік Node.js
      }
      sendJson(res, 200, {
        blockedMs: Number((performance.now() - start).toFixed(1)),
      })
      return
    }

    if (req.method === 'GET') {
      await serveStatic(config.clientDistDir, pathname, res)
      return
    }

    sendJson(res, 405, { error: 'Method not allowed' })
  } catch (err: unknown) {
    const status = err instanceof HttpStatusError ? err.statusCode : 500
    const message = err instanceof Error ? err.message : 'Internal server error'
    if (!res.headersSent) {
      sendJson(res, status, { error: message })
    }
  }
})

server.on('error', (err) => {
  console.error('[HTTP] server error:', err.message)
})

wsControl = attachWebSocketServer(server, { roomManager, config })

server.listen(config.port, config.host, () => {
  console.log(`[Server] listening on http://${config.host}:${config.port}`)
  console.log(`[Server] logs dir: ${config.logDir}`)
})

let shuttingDown = false
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[Server] received ${signal}, shutting down gracefully...`)

  const forceTimer = setTimeout(() => {
    console.error('[Server] graceful shutdown timed out, forcing exit')
    process.exit(1)
  }, 5000)
  forceTimer.unref()

  try {
    if (wsControl) await wsControl.closeAllSockets()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await roomManager.closeAll()
    console.log('[Server] flushed logs and closed sockets. Bye!')
    process.exit(0)
  } catch (err: unknown) {
    console.error('[Server] shutdown error:', err)
    process.exit(1)
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
