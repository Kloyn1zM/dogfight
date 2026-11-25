import {
  PROTOCOL_VERSION,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  encodeJsonMessage,
  parseClientMessage,
  type MatchEvent,
  type Tick,
} from '@dogfight/shared'
import type { ChatEntry, Room, RoomPlayer } from './rooms.ts'

export {
  PROTOCOL_VERSION,
  encodeJsonMessage as encodeMessage,
  parseClientMessage,
}

export function makeWelcome(
  player: RoomPlayer,
  room: Room,
  tick: Tick,
): string {
  return encodeJsonMessage({
    type: 'welcome',
    playerId: player.id,
    shipId: player.shipId,
    name: player.name,
    codec: player.codec,
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    tick,
    room: room.toPublicInfo(),
  })
}

export function makeRoster(room: Room): string {
  return encodeJsonMessage({
    type: 'roster',
    roomId: room.id,
    players: room.getRoster(),
  })
}

export function makeChat(entry: ChatEntry): string {
  return encodeJsonMessage({
    type: 'chat',
    playerId: entry.playerId,
    name: entry.name,
    text: entry.text,
    t: entry.t,
  })
}

export function makeSystem(text: string, t = Date.now()): string {
  return encodeJsonMessage({
    type: 'system',
    text,
    t,
  })
}

export function makeEvents(tick: Tick, events: readonly MatchEvent[]): string {
  return encodeJsonMessage({
    type: 'events',
    tick,
    events,
  })
}

export function makeError(reason: string): string {
  return encodeJsonMessage({
    type: 'error',
    reason,
  })
}

export function makeShutdown(reason: string): string {
  return encodeJsonMessage({
    type: 'shutdown',
    reason,
  })
}
