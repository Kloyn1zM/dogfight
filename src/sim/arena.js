export function createArena(width = 0, height = 0) {
  return { width, height }
}

/** Тороїдальне замикання координат у межах арени [0, width) × [0, height). */
export function wrap(entity, arena) {
  if (arena.width <= 0 || arena.height <= 0) return
  entity.pos.x = ((entity.pos.x % arena.width) + arena.width) % arena.width
  entity.pos.y = ((entity.pos.y % arena.height) + arena.height) % arena.height
}

/**
 * Якщо за крок симуляції об'єкт телепортувався через край арени,
 * синхронізуємо prevPos, щоб інтерполяція не протягнула його крізь увесь екран.
 */
export function hideWrapForLerp(entity, arena) {
  if (Math.abs(entity.pos.x - entity.prevPos.x) > arena.width / 2) {
    entity.prevPos.x = entity.pos.x
  }
  if (Math.abs(entity.pos.y - entity.prevPos.y) > arena.height / 2) {
    entity.prevPos.y = entity.pos.y
  }
}

/** Пружне відбиття від стінок арени (для дрейфуючих астероїдів). */
export function bounce(entity, arena) {
  if (arena.width <= 0 || arena.height <= 0) return
  const r = entity.radius

  if (entity.pos.x < r) {
    entity.pos.x = r
    entity.vel.x = Math.abs(entity.vel.x)
  } else if (entity.pos.x > arena.width - r) {
    entity.pos.x = arena.width - r
    entity.vel.x = -Math.abs(entity.vel.x)
  }

  if (entity.pos.y < r) {
    entity.pos.y = r
    entity.vel.y = Math.abs(entity.vel.y)
  } else if (entity.pos.y > arena.height - r) {
    entity.pos.y = arena.height - r
    entity.vel.y = -Math.abs(entity.vel.y)
  }
}
