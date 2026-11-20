export const PROTOCOL_VERSION = 1

const ROOM_ID_RE = /^[a-z0-9-]{2,32}$/

export function encodeMessage(msg) {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...msg })
}

export function makeWelcome(player, room) {
  return encodeMessage({
    type: 'welcome',
    playerId: player.id,
    name: player.name,
    room: room.toPublicInfo(),
  })
}

export function makeRoster(room) {
  return encodeMessage({
    type: 'roster',
    roomId: room.id,
    players: room.getRoster(),
  })
}

export function makeChat({ playerId, name, text, t = Date.now() }) {
  return encodeMessage({
    type: 'chat',
    playerId,
    name,
    text,
    t,
  })
}

export function makeSystem(text, t = Date.now()) {
  return encodeMessage({
    type: 'system',
    text,
    t,
  })
}

export function makeError(reason) {
  return encodeMessage({
    type: 'error',
    reason,
  })
}

/**
 * Сувора валідація кожного вхідного повідомлення від клієнта.
 * Ніколи не довіряємо структурі даних із мережі.
 */
export function validateClientMessage(rawText) {
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
      return {
        ok: true,
        msg: { v: PROTOCOL_VERSION, type: 'join', room: data.room, name },
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
