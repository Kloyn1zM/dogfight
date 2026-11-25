import {
  asEntityId,
  asSeq,
  asTick,
  type EntityId,
  type InputCommand,
  type TurnDirection,
} from '../types.ts'
import {
  DRAG,
  MAX_SPEED,
  ROTATE_SPEED,
  SHIP_MAX_HP,
  SHIP_RADIUS,
  THRUST,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from './constants.ts'

const TAU = Math.PI * 2

export interface Positioned {
  x: number
  y: number
}

export interface MovingBounded extends Positioned {
  vx: number
  vy: number
  radius: number
}

export interface ShipState {
  id: EntityId
  kind: 'ship'
  x: number
  y: number
  vx: number
  vy: number
  angle: number
  radius: number
  hp: number
  maxHp: number
  score: number
  alive: boolean
  thrust: number
  fireCooldown: number
  homingCooldown: number
  shieldTimer: number
  rapidFireTimer: number
  respawnTimer: number
}

export interface ShipMotionInput {
  readonly turn: TurnDirection
  readonly thrust: boolean
}

export function normalizeAngle(angle: number): number {
  let a = ((((angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI
  if (a <= -Math.PI) a += TAU
  return a
}

export function shortestAngleDiff(from: number, to: number): number {
  let delta = ((to - from) % TAU) + TAU
  delta %= TAU
  if (delta > Math.PI) delta -= TAU
  return delta
}

export function normalizeInput(
  raw: Partial<{
    seq: number
    tick: number
    turn: number
    thrust: boolean
    fire: boolean
    fireHoming: boolean
  }> = {},
): InputCommand {
  const turnRaw = Number(raw.turn ?? 0)
  const turn: TurnDirection = turnRaw > 0 ? 1 : turnRaw < 0 ? -1 : 0
  const seq =
    typeof raw.seq === 'number' && Number.isInteger(raw.seq) && raw.seq >= 0
      ? raw.seq
      : 0
  const tick =
    typeof raw.tick === 'number' && Number.isInteger(raw.tick) && raw.tick >= 0
      ? raw.tick
      : 0

  return {
    seq: asSeq(seq),
    tick: asTick(tick),
    turn,
    thrust: Boolean(raw.thrust),
    fire: Boolean(raw.fire),
    fireHoming: Boolean(raw.fireHoming),
  }
}

export function createShipState({
  id = asEntityId(1),
  x = WORLD_WIDTH / 2,
  y = WORLD_HEIGHT / 2,
  angle = -Math.PI / 2,
}: {
  id?: EntityId
  x?: number
  y?: number
  angle?: number
} = {}): ShipState {
  return {
    id,
    kind: 'ship',
    x,
    y,
    vx: 0,
    vy: 0,
    angle,
    radius: SHIP_RADIUS,
    hp: SHIP_MAX_HP,
    maxHp: SHIP_MAX_HP,
    score: 0,
    alive: true,
    thrust: 0,
    fireCooldown: 0,
    homingCooldown: 0,
    shieldTimer: 0,
    rapidFireTimer: 0,
    respawnTimer: 0,
  }
}

export function cloneShipState(ship: ShipState): ShipState {
  return { ...ship }
}

export function copyShipState(dst: ShipState, src: ShipState): void {
  dst.id = src.id
  dst.x = src.x
  dst.y = src.y
  dst.vx = src.vx
  dst.vy = src.vy
  dst.angle = src.angle
  dst.radius = src.radius
  dst.hp = src.hp
  dst.maxHp = src.maxHp
  dst.score = src.score
  dst.alive = src.alive
  dst.thrust = src.thrust
  dst.fireCooldown = src.fireCooldown
  dst.homingCooldown = src.homingCooldown
  dst.shieldTimer = src.shieldTimer
  dst.rapidFireTimer = src.rapidFireTimer
  dst.respawnTimer = src.respawnTimer
}

export function wrapPosition(
  entity: Positioned,
  width = WORLD_WIDTH,
  height = WORLD_HEIGHT,
): void {
  entity.x = ((entity.x % width) + width) % width
  entity.y = ((entity.y % height) + height) % height
}

export function bouncePosition(
  entity: MovingBounded,
  width = WORLD_WIDTH,
  height = WORLD_HEIGHT,
): void {
  const r = entity.radius
  if (entity.x < r) {
    entity.x = r
    entity.vx = Math.abs(entity.vx)
  } else if (entity.x > width - r) {
    entity.x = width - r
    entity.vx = -Math.abs(entity.vx)
  }

  if (entity.y < r) {
    entity.y = r
    entity.vy = Math.abs(entity.vy)
  } else if (entity.y > height - r) {
    entity.y = height - r
    entity.vy = -Math.abs(entity.vy)
  }
}

export function integrateShip(
  ship: ShipState,
  input: ShipMotionInput,
  dt: number,
  width = WORLD_WIDTH,
  height = WORLD_HEIGHT,
): void {
  if (!ship.alive) return

  ship.fireCooldown = Math.max(0, ship.fireCooldown - dt)
  ship.homingCooldown = Math.max(0, ship.homingCooldown - dt)
  ship.shieldTimer = Math.max(0, ship.shieldTimer - dt)
  ship.rapidFireTimer = Math.max(0, ship.rapidFireTimer - dt)

  const turn = input.turn > 0 ? 1 : input.turn < 0 ? -1 : 0
  const thrusting = Boolean(input.thrust)

  ship.angle = normalizeAngle(ship.angle + turn * ROTATE_SPEED * dt)
  ship.thrust = thrusting ? THRUST : 0

  if (thrusting) {
    ship.vx += Math.cos(ship.angle) * THRUST * dt
    ship.vy += Math.sin(ship.angle) * THRUST * dt
  }

  const damp = Math.exp(-DRAG * dt)
  ship.vx *= damp
  ship.vy *= damp

  const speed = Math.hypot(ship.vx, ship.vy)
  if (speed > MAX_SPEED) {
    const scale = MAX_SPEED / speed
    ship.vx *= scale
    ship.vy *= scale
  }

  ship.x += ship.vx * dt
  ship.y += ship.vy * dt
  wrapPosition(ship, width, height)
}

export function hashShipState(ship: ShipState): string {
  const str = [
    ship.x.toFixed(6),
    ship.y.toFixed(6),
    ship.vx.toFixed(6),
    ship.vy.toFixed(6),
    ship.angle.toFixed(6),
    ship.thrust,
  ].join('|')

  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
