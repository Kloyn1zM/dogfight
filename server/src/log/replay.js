import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

const REPLAY_ID_RE = /^[a-zA-Z0-9_-]+$/

/**
 * Async-генератор поверх createReadStream: читає NDJSON-лог порціями
 * і віддає розпарсені події, ніколи не тримаючи весь файл у RAM.
 */
export async function* readReplayEvents(filePath) {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  let leftover = ''

  for await (const chunk of stream) {
    leftover += chunk
    const lines = leftover.split('\n')
    leftover = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      yield JSON.parse(trimmed)
    }
  }

  const tail = leftover.trim()
  if (tail) {
    yield JSON.parse(tail)
  }
}

export async function listReplays(logDir) {
  try {
    const entries = await readdir(logDir)
    const items = []
    for (const name of entries) {
      if (!name.endsWith('.ndjson')) continue
      const full = path.join(logDir, name)
      const info = await stat(full)
      items.push({
        id: name.slice(0, -'.ndjson'.length),
        bytes: info.size,
        updatedAt: info.mtime.toISOString(),
      })
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return items
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

/**
 * Стрімить файл реплею клієнту через pipeline(createReadStream, res)
 * з автоматичним backpressure: RSS сервера лишається стабільним навіть на 200 MB файлі.
 */
export async function streamReplayToResponse(logDir, replayId, res) {
  if (!REPLAY_ID_RE.test(replayId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid replay id' }))
    return
  }

  const filePath = path.join(logDir, `${replayId}.ndjson`)
  let info
  try {
    info = await stat(filePath)
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Replay not found' }))
    return
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Content-Length': String(info.size),
  })

  try {
    await pipeline(createReadStream(filePath), res)
  } catch (err) {
    // Клієнт міг сам обірвати завантаження — це штатний випадок
    if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE' && !res.writableEnded) {
      res.destroy(err)
    }
  }
}
