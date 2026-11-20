import { createWriteStream, mkdirSync } from 'node:fs'
import path from 'node:path'
import { PassThrough, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * Object-mode Transform stream: перетворює об'єкти подій кімнати
 * на рядки NDJSON (Newline-Delimited JSON).
 */
export class JsonLinesTransform extends Transform {
  constructor() {
    super({ writableObjectMode: true, readableObjectMode: false })
  }

  _transform(chunk, _encoding, callback) {
    try {
      callback(null, `${JSON.stringify(chunk)}\n`)
    } catch (err) {
      callback(err)
    }
  }
}

/**
 * Стрімовий запис логу матчу кімнати на диск через pipeline():
 * автоматично обробляє backpressure, помилки та закриття файлу.
 */
export function createMatchLog(room, logDir) {
  mkdirSync(logDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safeRoom = room.id.replace(/[^a-z0-9_-]/gi, '')
  const id = `${safeRoom}-${stamp}`
  const filePath = path.join(logDir, `${id}.ndjson`)

  const source = new PassThrough({ objectMode: true })
  const transform = new JsonLinesTransform()
  const fileStream = createWriteStream(filePath, { flags: 'a' })

  const done = pipeline(source, transform, fileStream).catch((err) => {
    console.error(`[MatchLog] pipeline error (${id}):`, err.message)
  })

  let closed = false

  function onEvent(evt) {
    if (closed) return
    source.write(evt)
  }

  room.on('event', onEvent)

  return {
    id,
    filePath,
    async close() {
      if (closed) return
      closed = true
      room.off('event', onEvent)
      source.end()
      await done
    },
  }
}
