const TAU = Math.PI * 2

function shortestAngleDiff(from, to) {
  let delta = ((to - from) % TAU) + TAU
  delta %= TAU
  if (delta > Math.PI) delta -= TAU
  return delta
}

/**
 * Компонент самонаведення (композиція).
 * Може бути прикріплений і до кулі (наводиться на 'asteroid'),
 * і до астероїда (переслідує 'ship') без створення окремих підкласів.
 */
export function createHoming({
  targetKind = 'asteroid',
  ignoreId = null,
  turnRate = 3.5,
  speed = 320,
} = {}) {
  return {
    type: 'homing',
    targetKind,
    ignoreId,
    turnRate,
    speed,
    update(entity, dt, world) {
      let nearest = null
      let bestDistSq = Infinity

      for (const candidate of world.ofKind(targetKind)) {
        if (!candidate.alive) continue
        if (candidate.id === entity.id || candidate.id === ignoreId) continue

        const dx = candidate.pos.x - entity.pos.x
        const dy = candidate.pos.y - entity.pos.y
        const distSq = dx * dx + dy * dy
        if (distSq < bestDistSq) {
          bestDistSq = distSq
          nearest = candidate
        }
      }

      if (!nearest) return

      const desiredAngle = Math.atan2(
        nearest.pos.y - entity.pos.y,
        nearest.pos.x - entity.pos.x,
      )
      const currentAngle = Math.atan2(entity.vel.y, entity.vel.x)
      const diff = shortestAngleDiff(currentAngle, desiredAngle)
      const maxTurn = turnRate * dt
      const step = Math.max(-maxTurn, Math.min(maxTurn, diff))
      const nextAngle = currentAngle + step

      entity.angle = nextAngle
      entity.vel.x = Math.cos(nextAngle) * speed
      entity.vel.y = Math.sin(nextAngle) * speed
    },
  }
}

/**
 * Компонент бонусу (поведінка як дані).
 * Стаціонарний об'єкт із колізією, який передає ефект кораблю при підборі.
 */
export function createPickupEffect({ effect = 'shield', duration = 6 } = {}) {
  return {
    type: 'pickup',
    effect,
    duration,
  }
}

export function runBehaviors(entity, dt, world) {
  for (const behavior of entity.behaviors) {
    if (typeof behavior.update === 'function') {
      behavior.update(entity, dt, world)
    }
  }
}

export function hasBehavior(entity, type) {
  return entity.behaviors.some((b) => b.type === type)
}

export function getBehavior(entity, type) {
  return entity.behaviors.find((b) => b.type === type)
}
