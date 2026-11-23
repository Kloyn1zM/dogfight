import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

const REPLAY_ID_RE = /^[a-zA-Z0-9_-]+$/

export interface ReplaySummary {
  readonly id: string
  readonly bytes: number
  readonly updatedAt: string
}

function getErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = err.code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

export async function* readReplayEvents(
  filePath: string,
): AsyncGenerator<unknown> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  let leftover = ''

  for await (const chunk of stream) {
    leftover += String(chunk)
    const lines = leftover.split('\n')
    leftover = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parsed: unknown = JSON.parse(trimmed)
      yield parsed
    }
  }

  const tail = leftover.trim()
  if (tail) {
    const parsed: unknown = JSON.parse(tail)
    yield parsed
  }
}

export async function listReplays(logDir: string): Promise<ReplaySummary[]> {
  try {
    const entries = await readdir(logDir)
    const items: ReplaySummary[] = []
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
  } catch (err: unknown) {
    if (getErrorCode(err) === 'ENOENT') return []
    throw err
  }
}

export async function streamReplayToResponse(
  logDir: string,
  replayId: string,
  res: ServerResponse,
): Promise<void> {
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
  } catch (err: unknown) {
    if (
      getErrorCode(err) !== 'ERR_STREAM_PREMATURE_CLOSE' &&
      !res.writableEnded
    ) {
      res.destroy(err instanceof Error ? err : new Error(String(err)))
    }
  }
}
