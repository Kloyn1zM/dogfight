import { createWriteStream, mkdirSync } from 'node:fs'
import path from 'node:path'
import { PassThrough, Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Room, RoomLogEvent } from '../rooms.ts'

export interface MatchLogHandle {
  readonly id: string
  readonly filePath: string
  close(): Promise<void>
}

export class JsonLinesTransform extends Transform {
  constructor() {
    super({ writableObjectMode: true, readableObjectMode: false })
  }

  override _transform(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      callback(null, `${JSON.stringify(chunk)}\n`)
    } catch (err: unknown) {
      callback(err instanceof Error ? err : new Error(String(err)))
    }
  }
}

export function createMatchLog(room: Room, logDir: string): MatchLogHandle {
  mkdirSync(logDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeRoom = room.id.replace(/[^a-z0-9_-]/gi, '')
  const id = `${safeRoom}-${stamp}`
  const filePath = path.join(logDir, `${id}.ndjson`)

  const source = new PassThrough({ objectMode: true })
  const transform = new JsonLinesTransform()
  const fileStream = createWriteStream(filePath, { flags: 'a' })

  const done = pipeline(source, transform, fileStream).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[MatchLog] pipeline error (${id}):`, msg)
  })

  let closed = false

  function onEvent(evt: RoomLogEvent): void {
    if (closed) return
    source.write(evt)
  }

  room.on('event', onEvent)

  return {
    id,
    filePath,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      room.off('event', onEvent)
      source.end()
      await done
    },
  }
}
