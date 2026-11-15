export function lerp(a, b, t) {
  return a + (b - a) * t
}

/**
 * Короткий шлях інтерполяції кута по колу: зводить різницю в (-π, π],
 * щоб перехід між 359° і 1° не розвертав корабель навпаки.
 */
export function lerpAngle(from, to, t) {
  const tau = Math.PI * 2
  let delta = ((to - from) % tau) + tau
  delta %= tau
  if (delta > Math.PI) delta -= tau
  return from + delta * t
}

export function interpolateShip(
  previous,
  current,
  alpha,
  out = { x: 0, y: 0, angle: 0, thrust: 0 },
) {
  out.x = lerp(previous.x, current.x, alpha)
  out.y = lerp(previous.y, current.y, alpha)
  out.angle = lerpAngle(previous.angle, current.angle, alpha)
  out.thrust = current.thrust
  return out
}

export function createStarfield(width, height, count = 140) {
  const stars = []
  for (let i = 0; i < count; i += 1) {
    stars.push({
      x: Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1) * width,
      y: Math.abs((Math.sin(i * 78.233) * 24634.6345) % 1) * height,
      r: i % 5 === 0 ? 1.5 : 0.7,
    })
  }
  return stars
}

export function drawBackground(ctx, width, height) {
  ctx.fillStyle = '#0e1016'
  ctx.fillRect(0, 0, width, height)
}

export function drawGrid(ctx, width, height, step = 64) {
  ctx.strokeStyle = '#1a2030'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = 0; x <= width; x += step) {
    ctx.moveTo(x + 0.5, 0)
    ctx.lineTo(x + 0.5, height)
  }
  for (let y = 0; y <= height; y += step) {
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(width, y + 0.5)
  }
  ctx.stroke()
}

export function drawStarfield(ctx, stars) {
  ctx.fillStyle = '#8b93a7'
  ctx.beginPath()
  for (const star of stars) {
    ctx.moveTo(star.x + star.r, star.y)
    ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2)
  }
  ctx.fill()
}

export function drawShip(ctx, ship) {
  ctx.save()
  ctx.translate(ship.x, ship.y)
  ctx.rotate(ship.angle)

  if (ship.thrust > 0) {
    ctx.fillStyle = '#fb923c'
    ctx.beginPath()
    ctx.moveTo(-10, 0)
    ctx.lineTo(-20, -5)
    ctx.lineTo(-14, 0)
    ctx.lineTo(-20, 5)
    ctx.closePath()
    ctx.fill()
  }

  ctx.fillStyle = '#e5e7eb'
  ctx.beginPath()
  ctx.moveTo(16, 0)
  ctx.lineTo(-12, -10)
  ctx.lineTo(-6, 0)
  ctx.lineTo(-12, 10)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

export function drawHud(ctx, stats, { paused = false } = {}) {
  ctx.fillStyle = '#e5e7eb'
  ctx.font = '16px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillText(`steps/s   ${stats.stepsPerSecond}`, 24, 36)
  ctx.fillText(`frames/s  ${stats.framesPerSecond}`, 24, 60)
  ctx.fillText(`frame ms  ${stats.frameTimeMs.toFixed(2)}`, 24, 84)

  ctx.fillStyle = '#9ca3af'
  ctx.fillText('W/A/D або стрілки — літати · R — центр · Пробіл — пауза', 24, 116)

  if (paused) {
    ctx.fillStyle = '#fb923c'
    ctx.fillText('PAUSED', 24, 144)
  }
}
