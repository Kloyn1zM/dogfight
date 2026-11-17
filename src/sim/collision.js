/**
 * Система виявлення колізій (коло-коло), O(n²).
 * Винесена в окрему функцію-генератор, щоб у Lab 7 її можна було
 * безболісно замінити на Spatial Hash без переписування World.
 */
export function* detectCollisions(world) {
  const colliders = []
  for (const entity of world) {
    if (entity.alive && entity.radius > 0) {
      colliders.push(entity)
    }
  }

  for (let i = 0; i < colliders.length; i += 1) {
    const a = colliders[i]
    for (let j = i + 1; j < colliders.length; j += 1) {
      const b = colliders[j]
      const dx = b.pos.x - a.pos.x
      const dy = b.pos.y - a.pos.y
      const r = a.radius + b.radius
      if (dx * dx + dy * dy <= r * r) {
        yield [a, b]
      }
    }
  }
}
