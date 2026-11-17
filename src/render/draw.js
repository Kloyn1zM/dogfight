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

export function drawWorld(ctx, world, alpha) {
  for (const entity of world) {
    if (!entity.alive) continue

    const x = lerp(entity.prevPos.x, entity.pos.x, alpha)
    const y = lerp(entity.prevPos.y, entity.pos.y, alpha)
    const angle = lerpAngle(entity.prevAngle, entity.angle, alpha)

    switch (entity.kind) {
      case 'ship':
        drawShip(ctx, x, y, angle, entity)
        break
      case 'bullet':
        drawBullet(ctx, x, y, angle, entity)
        break
      case 'asteroid':
        drawAsteroid(ctx, x, y, entity)
        break
      case 'pickup':
        drawPickup(ctx, x, y, angle, entity)
        break
      case 'explosion':
        drawExplosion(ctx, entity)
        break
    }
  }
}

function drawShip(ctx, x, y, angle, ship) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)

  if (ship.thrust > 0) {
    ctx.fillStyle = ship.rapidFireActive ? '#38bdf8' : '#fb923c'
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

  if (ship.shieldActive) {
    ctx.strokeStyle = '#38bdf8'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(0, 0, ship.radius + 7, 0, Math.PI * 2)
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

function drawAsteroid(ctx, x, y, asteroid) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(asteroid.visualAngle)

  ctx.strokeStyle = asteroid.isHoming ? '#f43f5e' : '#94a3b8'
  ctx.fillStyle = asteroid.isHoming ? '#3b121e' : '#1e293b'
  ctx.lineWidth = 2
  ctx.beginPath()

  const sides = 8
  for (let i = 0; i < sides; i += 1) {
    const a = (Math.PI * 2 * i) / sides
    const wobble = i % 2 === 0 ? 1 : 0.82
    const px = Math.cos(a) * asteroid.radius * wobble
    const py = Math.sin(a) * asteroid.radius * wobble
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

function drawPickup(ctx, x, y, angle, pickup) {
  const isShield = pickup.effect === 'shield'
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)

  ctx.strokeStyle = isShield ? '#38bdf8' : '#f59e0b'
  ctx.fillStyle = isShield
    ? 'rgba(56, 189, 248, 0.2)'
    : 'rgba(245, 158, 11, 0.2)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.rect(-10, -10, 20, 20)
  ctx.fill()
  ctx.stroke()

  ctx.fillStyle = isShield ? '#38bdf8' : '#f59e0b'
  ctx.font = 'bold 13px ui-monospace, SFMono-Regular, Menlo, monospace'
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

export function drawHud(ctx, stats, world, { paused = false } = {}) {
  const player = world.getPlayer()

  ctx.fillStyle = '#e5e7eb'
  ctx.font = '15px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillText(`steps/s   ${stats.stepsPerSecond}`, 24, 34)
  ctx.fillText(`frames/s  ${stats.framesPerSecond}`, 24, 56)
  ctx.fillText(`frame ms  ${stats.frameTimeMs.toFixed(2)}`, 24, 78)

  ctx.fillStyle = '#facc15'
  ctx.fillText(`SCORE     ${world.score}`, 24, 110)

  if (player && player.alive) {
    ctx.fillStyle = player.hp > 35 ? '#4ade80' : '#f87171'
    ctx.fillText(`HP        ${player.hp}/${player.maxHp}`, 24, 132)

    let buffY = 154
    if (player.shieldActive) {
      ctx.fillStyle = '#38bdf8'
      ctx.fillText(`SHIELD    ${player.shieldTimer.toFixed(1)}s`, 24, buffY)
      buffY += 22
    }
    if (player.rapidFireActive) {
      ctx.fillStyle = '#f59e0b'
      ctx.fillText(`RAPID     ${player.rapidFireTimer.toFixed(1)}s`, 24, buffY)
    }
  } else {
    ctx.fillStyle = '#f87171'
    ctx.fillText(`RESPAWN   ${world.respawnTimer.toFixed(1)}s`, 24, 132)
  }

  ctx.fillStyle = '#9ca3af'
  ctx.fillText(
    'W/A/D — політ · Пробіл / Клік — постріл · E — homing · P — пауза · R — рестарт',
    24,
    ctx.canvas.clientHeight - 24,
  )

  if (paused) {
    ctx.fillStyle = '#fb923c'
    ctx.font = 'bold 20px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillText('PAUSED', 24, 186)
  }
}
