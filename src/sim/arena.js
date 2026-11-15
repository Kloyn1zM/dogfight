export function createArena(width = 0, height = 0) {
  return { width, height }
}

/** Тороїдальне замикання координат у межах арени [0, width) × [0, height). */
export function wrap(entity, arena) {
  if (arena.width <= 0 || arena.height <= 0) return
  entity.x = ((entity.x % arena.width) + arena.width) % arena.width
  entity.y = ((entity.y % arena.height) + arena.height) % arena.height
}

/**
 * Якщо за крок симуляції об'єкт телепортувався через край арени,
 * синхронізуємо previous, щоб інтерполяція не протягнула його крізь увесь екран.
 */
export function hideWrapForLerp(previous, current, arena) {
  if (Math.abs(current.x - previous.x) > arena.width / 2) {
    previous.x = current.x
  }
  if (Math.abs(current.y - previous.y) > arena.height / 2) {
    previous.y = current.y
  }
}
