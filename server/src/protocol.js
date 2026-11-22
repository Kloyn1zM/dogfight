import {
  PROTOCOL_VERSION,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  encodeJsonMessage,
  validateClientJsonMessage,
} from '@dogfight/shared'

export { PROTOCOL_VERSION, encodeJsonMessage as encodeMessage }
export { validateClientJsonMessage as validateClientMessage }

export function makeWelcome(player, room, match) {
  return encodeJsonMessage({
    type: 'welcome',
    playerId: player.id,
    shipId: player.shipId,
    name: player.name,
    codec: player.codec,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    tick: match.tick,
    room: room.toPublicInfo(),
  })
}

export function makeRoster(room) {
  return encodeJsonMessage({
    type: 'roster',
    roomId: room.id,
    players: room.getRoster(),
  })
}

export function makeChat({ playerId, name, text, t = Date.now() }) {
  return encodeJsonMessage({
    type: 'chat',
    playerId,
    name,
    text,
    t,
  })
}

export function makeSystem(text, t = Date.now()) {
  return encodeJsonMessage({
    type: 'system',
    text,
    t,
  })
}

export function makeEvents(tick, events) {
  return encodeJsonMessage({
    type: 'events',
    tick,
    events,
  })
}

export function makeError(reason) {
  return encodeJsonMessage({
    type: 'error',
    reason,
  })
}
