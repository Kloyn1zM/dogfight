import { PROTOCOL_VERSION } from './sim/constants.js'
import { normalizeInput } from './sim/physics.js'

const ROOM_ID_RE = /^[a-z0-9-]{2,32}$/

export { PROTOCOL_VERSION }

export function encodeJsonMessage(msg) {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...msg })
}

export function validateClientJsonMessage(rawText) {
  let data
  try {
    data = JSON.parse(rawText)
  } catch {
    return { ok: false, code: 1007, reason: 'Invalid JSON payload' }
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 1008, reason: 'Message must be a JSON object' }
  }

  if (data.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: 1008,
      reason: `Unsupported protocol version: ${String(data.v)}`,
    }
  }

  if (typeof data.type !== 'string') {
    return { ok: false, code: 1008, reason: 'Missing message type' }
  }

  switch (data.type) {
    case 'join': {
      if (typeof data.room !== 'string' || !ROOM_ID_RE.test(data.room)) {
        return { ok: false, code: 1008, reason: 'Invalid room id' }
      }
      if (typeof data.name !== 'string') {
        return { ok: false, code: 1008, reason: 'Invalid player name' }
      }
      const name = data.name.trim()
      if (name.length < 1 || name.length > 16) {
        return {
          ok: false,
          code: 1008,
          reason: 'Player name must be 1..16 characters',
        }
      }
      const codec = data.codec === 'json' ? 'json' : 'binary'
      return {
        ok: true,
        msg: {
          v: PROTOCOL_VERSION,
          type: 'join',
          room: data.room,
          name,
          codec,
        },
      }
    }

    case 'chat': {
      if (typeof data.text !== 'string') {
        return { ok: false, code: 1008, reason: 'Chat text must be a string' }
      }
      const text = data.text.trim()
      if (text.length < 1 || text.length > 200) {
        return {
          ok: false,
          code: 1008,
          reason: 'Chat text must be 1..200 characters',
        }
      }
      return { ok: true, msg: { v: PROTOCOL_VERSION, type: 'chat', text } }
    }

    case 'input': {
      if (
        typeof data.seq !== 'number' ||
        !Number.isInteger(data.seq) ||
        data.seq < 0
      ) {
        return { ok: false, code: 1008, reason: 'Invalid input seq' }
      }
      if (
        typeof data.turn !== 'number' ||
        (data.turn !== -1 && data.turn !== 0 && data.turn !== 1)
      ) {
        return { ok: false, code: 1008, reason: 'Invalid input turn (-1|0|1)' }
      }
      return {
        ok: true,
        msg: {
          v: PROTOCOL_VERSION,
          type: 'input',
          ...normalizeInput(data),
        },
      }
    }

    case 'codec': {
      const mode = data.mode === 'json' ? 'json' : 'binary'
      return { ok: true, msg: { v: PROTOCOL_VERSION, type: 'codec', mode } }
    }

    case 'netcfg': {
      const rttMs = Math.max(0, Math.min(600, Number(data.rttMs) || 0))
      const jitterMs = Math.max(0, Math.min(200, Number(data.jitterMs) || 0))
      const dropRate = Math.max(0, Math.min(0.3, Number(data.dropRate) || 0))
      return {
        ok: true,
        msg: {
          v: PROTOCOL_VERSION,
          type: 'netcfg',
          rttMs,
          jitterMs,
          dropRate,
        },
      }
    }

    case 'ping': {
      const t =
        typeof data.t === 'number' && Number.isFinite(data.t)
          ? data.t
          : Date.now()
      return { ok: true, msg: { v: PROTOCOL_VERSION, type: 'ping', t } }
    }

    default:
      return {
        ok: false,
        code: 1008,
        reason: `Unknown message type: ${data.type}`,
      }
  }
}
