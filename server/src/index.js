import http from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { loadConfig } from './config.js'
import { RoomManager } from './rooms.js'
import { attachWebSocketServer } from './ws.js'
import { listReplays, streamReplayToResponse } from './log/replay.js'

const MIME_TYPES = {
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

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  const chunks = []
  let total = 0

  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) {
      const err = new Error('Request body too large')
      err.statusCode = 413
      throw err
    }
    chunks.push(chunk)
  }

  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw)
  } catch {
    const err = new Error('Malformed JSON body')
    err.statusCode = 400
    throw err
  }
}

async function serveStatic(distDir, pathname, res) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    sendJson(res, 400, { error: 'Invalid URL encoding' })
    return
  }

  // Path-traversal захист: забороняємо вихід за межі client/dist
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
  const mime = MIME_TYPES[ext] || 'application/octet-stream'

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': String(info.size),
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  })

  try {
    await pipeline(createReadStream(filePath), res)
  } catch (err) {
    if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE' && !res.writableEnded) {
      res.destroy(err)
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

let wsControl = null

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`,
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

    if (req.method === 'GET' && pathname === '/api/rooms') {
      sendJson(res, 200, roomManager.list())
      return
    }

    if (req.method === 'POST' && pathname === '/api/rooms') {
      const body = await readJsonBody(req)
      if (!body || typeof body !== 'object' || typeof body.name !== 'string') {
        sendJson(res, 400, { error: 'Field "name" (string) is required' })
        return
      }
      try {
        const room = roomManager.create({
          name: body.name,
          difficulty:
            typeof body.difficulty === 'string' ? body.difficulty : 'Normal',
          persistent: false,
        })
        sendJson(res, 201, room.toPublicInfo())
      } catch (err) {
        sendJson(res, 400, { error: err.message })
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

    // Навмисний блокуючий ендпоінт для демонстрації event loop (Lab 4 M4)
    if (
      req.method === 'GET' &&
      pathname === '/api/slow' &&
      config.enableSlowDemo
    ) {
      const ms = Math.min(
        1000,
        Math.max(10, Number(url.searchParams.get('ms') || 300)),
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
  } catch (err) {
    const status = err.statusCode || 500
    if (!res.headersSent) {
      sendJson(res, status, { error: err.message || 'Internal server error' })
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
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[Server] received ${signal}, shutting down gracefully...`)

  const forceTimer = setTimeout(() => {
    console.error('[Server] graceful shutdown timed out, forcing exit')
    process.exit(1)
  }, 5000)
  forceTimer.unref()

  try {
    await wsControl.closeAllSockets()
    await new Promise((resolve) => server.close(resolve))
    await roomManager.closeAll()
    console.log('[Server] flushed logs and closed sockets. Bye!')
    process.exit(0)
  } catch (err) {
    console.error('[Server] shutdown error:', err)
    process.exit(1)
  }
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
