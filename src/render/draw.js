const SPRITE_CELL = 64

export function lerp(a, b, t) {
  return a + (b - a) * t
}

export function lerpAngle(from, to, t) {
  const tau = Math.PI * 2
  let delta = ((to - from) % tau) + tau
  delta %= tau
  if (delta > Math.PI) delta -= tau
  return from + delta * t
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

export function drawBackground(ctx, width, height, color = '#0e1016') {
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
}

export function drawGrid(ctx, width, height, color = '#1a2030', step = 64) {
  ctx.strokeStyle = color
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

export function drawLoadingScreen(
  ctx,
  width,
  height,
  { ratio = 0, label = '', error = null } = {},
) {
  drawBackground(ctx, width, height, '#0e1016')
  const cx = width / 2
  const cy = height / 2
  const barW = Math.min(360, width - 64)
  const barH = 18

  ctx.save()
  ctx.textAlign = 'center'
  ctx.fillStyle = '#e5e7eb'
  ctx.font = 'bold 22px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillText(
    error ? 'ПОМИЛКА ЗАВАНТАЖЕННЯ' : 'ЗАВАНТАЖЕННЯ АСЕТІВ',
    cx,
    cy - 48,
  )

  ctx.strokeStyle = error ? '#f87171' : '#334155'
  ctx.lineWidth = 2
  ctx.strokeRect(cx - barW / 2, cy - barH / 2, barW, barH)

  ctx.fillStyle = error ? '#ef4444' : '#38bdf8'
  ctx.fillRect(
    cx - barW / 2 + 2,
    cy - barH / 2 + 2,
    (barW - 4) * ratio,
    barH - 4,
  )

  ctx.font = '14px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillStyle = error ? '#fca5a5' : '#94a3b8'
  const pct = Math.round(ratio * 100)
  ctx.fillText(error ? error : `${pct}% · ${label}`, cx, cy + 34)
  ctx.restore()
}

export function drawWorld(ctx, world, alpha, spriteSheet = null) {
  for (const entity of world) {
    if (!entity.alive) continue

    const x = lerp(entity.prevPos.x, entity.pos.x, alpha)
    const y = lerp(entity.prevPos.y, entity.pos.y, alpha)
    const angle = lerpAngle(entity.prevAngle, entity.angle, alpha)

    switch (entity.kind) {
      case 'ship':
        drawShip(ctx, x, y, angle, entity, spriteSheet)
        break
      case 'bullet':
        drawBullet(ctx, x, y, angle, entity)
        break
      case 'asteroid':
        drawAsteroid(ctx, x, y, entity, spriteSheet)
        break
      case 'pickup':
        drawPickup(ctx, x, y, angle, entity, spriteSheet)
        break
      case 'explosion':
        drawExplosion(ctx, entity)
        break
    }
  }
}

function drawSpriteCell(ctx, sheet, cellIndex, drawSize) {
  ctx.drawImage(
    sheet,
    cellIndex * SPRITE_CELL,
    0,
    SPRITE_CELL,
    SPRITE_CELL,
    -drawSize / 2,
    -drawSize / 2,
    drawSize,
    drawSize,
  )
}

function drawShip(ctx, x, y, angle, ship, sheet) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)

  if (ship.thrust > 0) {
    ctx.fillStyle = ship.rapidFireActive ? '#38bdf8' : '#fb923c'
    ctx.beginPath()
    ctx.moveTo(-12, 0)
    ctx.lineTo(-24, -6)
    ctx.lineTo(-17, 0)
    ctx.lineTo(-24, 6)
    ctx.closePath()
    ctx.fill()
  }

  if (sheet) {
    drawSpriteCell(ctx, sheet, 0, ship.radius * 3.1)
  } else {
    ctx.fillStyle = '#e5e7eb'
    ctx.beginPath()
    ctx.moveTo(16, 0)
    ctx.lineTo(-12, -10)
    ctx.lineTo(-6, 0)
    ctx.lineTo(-12, 10)
    ctx.closePath()
    ctx.fill()
  }

  if (ship.shieldActive) {
    ctx.strokeStyle = '#38bdf8'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(0, 0, ship.radius + 8, 0, Math.PI * 2)
    ctx.stroke()
  }

  ctx.restore()
}

function drawBullet(ctx, x, y, angle, bullet) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.fillStyle = bullet.isHoming ? '#c084fc' : '#facc15'
  ctx.beginPath()
  if (bullet.isHoming) {
    ctx.moveTo(8, 0)
    ctx.lineTo(-5, -4)
    ctx.lineTo(-5, 4)
    ctx.closePath()
  } else {
    ctx.arc(0, 0, bullet.radius, 0, Math.PI * 2)
  }
  ctx.fill()
  ctx.restore()
}

function drawAsteroid(ctx, x, y, asteroid, sheet) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(asteroid.visualAngle)

  if (sheet) {
    drawSpriteCell(ctx, sheet, asteroid.isHoming ? 2 : 1, asteroid.radius * 2.5)
  } else {
    ctx.strokeStyle = asteroid.isHoming ? '#f43f5e' : '#94a3b8'
    ctx.fillStyle = asteroid.isHoming ? '#3b121e' : '#1e293b'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let i = 0; i < 8; i += 1) {
      const a = (Math.PI * 2 * i) / 8
      const wobble = i % 2 === 0 ? 1 : 0.82
      const px = Math.cos(a) * asteroid.radius * wobble
      const py = Math.sin(a) * asteroid.radius * wobble
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()
}

function drawPickup(ctx, x, y, angle, pickup, sheet) {
  const isShield = pickup.effect === 'shield'
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)

  if (sheet) {
    drawSpriteCell(ctx, sheet, 3, pickup.radius * 2.6)
  } else {
    ctx.strokeStyle = isShield ? '#38bdf8' : '#f59e0b'
    ctx.fillStyle = isShield
      ? 'rgba(56, 189, 248, 0.2)'
      : 'rgba(245, 158, 11, 0.2)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.rect(-10, -10, 20, 20)
    ctx.fill()
    ctx.stroke()
  }

  ctx.fillStyle = isShield ? '#38bdf8' : '#f59e0b'
  ctx.font = 'bold 12px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(isShield ? 'S' : 'R', 0, 1)
  ctx.restore()
}

function drawExplosion(ctx, explosion) {
  const ratio = Math.max(0, explosion.ttl / explosion.maxTtl)
  ctx.save()
  ctx.globalAlpha = ratio
  ctx.fillStyle = explosion.color
  for (const p of explosion.particles) {
    ctx.beginPath()
    ctx.arc(p.x, p.y, p.r * ratio, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}
