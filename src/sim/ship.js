// Параметри керованості (підібрані під 60 Hz крок):
// ROTATE_SPEED 3.6 рад/с — повний оберт ~1.75 с: зручно точно цілитися.
// THRUST 520 px/с² — відчутний розгін за пів секунди.
// DRAG 1.15 с⁻¹ — експоненційне гальмування, коректне для будь-якого dt.
// MAX_SPEED 380 px/с — комфортна максимальна швидкість у межах арени.
export const ROTATE_SPEED = 3.6
export const THRUST = 520
export const DRAG = 1.15
export const MAX_SPEED = 380

export function createShip({ x = 0, y = 0, angle = -Math.PI / 2 } = {}) {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    angle,
    thrust: 0,
  }
}

export function cloneShip(ship) {
  return {
    x: ship.x,
    y: ship.y,
    vx: ship.vx,
    vy: ship.vy,
    angle: ship.angle,
    thrust: ship.thrust,
  }
}

/** Копіювання стану в наявний об'єкт без зайвих алокацій для GC. */
export function copyShip(target, source) {
  target.x = source.x
  target.y = source.y
  target.vx = source.vx
  target.vy = source.vy
  target.angle = source.angle
  target.thrust = source.thrust
  return target
}

/**
 * Чистий детермінований крок фізики корабля.
 * Не залежить від DOM, Canvas або клавіатури — працює однаково в браузері й Node.js.
 */
export function integrate(ship, command, dt) {
  const turn = Math.max(-1, Math.min(1, command.turn || 0))
  const thrusting = Boolean(command.thrust)

  ship.angle += turn * ROTATE_SPEED * dt

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
}
