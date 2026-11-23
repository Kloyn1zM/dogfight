import type { EntityKind } from '../types.ts'

export const PROTOCOL_VERSION = 2 as const

export const TICK_RATE = 30
export const TICK_DT = 1 / TICK_RATE
export const TICK_MS = 1000 / TICK_RATE

export const WORLD_WIDTH = 1280
export const WORLD_HEIGHT = 720

export const ROTATE_SPEED = 3.6
export const THRUST = 520
export const DRAG = 1.15
export const MAX_SPEED = 380

export const SHIP_RADIUS = 14
export const SHIP_MAX_HP = 100
export const BULLET_RADIUS = 4
export const PICKUP_RADIUS = 13

export const FIRE_COOLDOWN = 0.22
export const RAPID_FIRE_COOLDOWN = 0.09
export const HOMING_COOLDOWN = 0.85
export const RESPAWN_DELAY = 2.0

export const ENTITY_KIND = {
  ship: 1,
  bullet: 2,
  asteroid: 3,
  pickup: 4,
} as const satisfies Record<EntityKind, number>

export const KIND_FROM_CODE: Readonly<Record<number, EntityKind>> = {
  1: 'ship',
  2: 'bullet',
  3: 'asteroid',
  4: 'pickup',
}
