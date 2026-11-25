import {
  WORLD_HEIGHT,
  WORLD_WIDTH,
  assertNever,
  type ArenaConfig,
} from '@dogfight/shared'
import type {
  RenderAsteroid,
  RenderBullet,
  RenderExplosion,
  RenderPickup,
  RenderShip,
  RenderState,
} from '../net/netWorld.ts'

const SPRITE_CELL = 64

export interface Star {
  readonly x: number
  readonly y: number
  readonly r: number
}

export interface LoadingScreenState {
  readonly ratio: number
  readonly label: string
  readonly error: string | null
}

export function createStarfield(
  width: number,
  height: number,
  count = 140,
): Star[] {
  const stars: Star[] = []
  for (let i = 0; i < count; i += 1) {
    stars.push({
      x: Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1) * width,
      y: Math.abs((Math.sin(i * 78.233) * 24634.6345) % 1) * height,
      r: i % 5 === 0 ? 1.5 : 0.7,
    })
  }
  return stars
}

export function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  color = '#0e1016',
): void {
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
}

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  color = '#1a2030',
  step = 64,
): void {
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

export function drawStarfield(
  ctx: CanvasRenderingContext2D,
  stars: readonly Star[],
): void {
  ctx.fillStyle = '#8b93a7'
  ctx.beginPath()
  for (const star of stars) {
    ctx.moveTo(star.x + star.r, star.y)
    ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2)
  }
  ctx.fill()
}

export function drawLoadingScreen(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  { ratio, label, error }: LoadingScreenState,
): void {
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
  ctx.fillText(error ?? `${pct}% · ${label}`, cx, cy + 34)
  ctx.restore()
}

export function drawMultiplayerArena(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  {
    theme,
    stars,
    renderState,
    spriteSheet,
  }: {
    theme?: Partial<ArenaConfig>
    stars: readonly Star[]
    renderState: RenderState
    spriteSheet: HTMLImageElement | null
  },
): void {
  drawBackground(ctx, canvasW, canvasH, '#07090e')

  const scale = Math.min(canvasW / WORLD_WIDTH, canvasH / WORLD_HEIGHT)
  const drawW = WORLD_WIDTH * scale
  const drawH = WORLD_HEIGHT * scale
  const offsetX = (canvasW - drawW) / 2
  const offsetY = (canvasH - drawH) / 2

  ctx.save()
  ctx.translate(offsetX, offsetY)
  ctx.scale(scale, scale)

  ctx.beginPath()
  ctx.rect(0, 0, WORLD_WIDTH, WORLD_HEIGHT)
  ctx.clip()

  drawBackground(ctx, WORLD_WIDTH, WORLD_HEIGHT, theme?.background ?? '#0e1016')
  drawGrid(ctx, WORLD_WIDTH, WORLD_HEIGHT, theme?.gridColor ?? '#1a2030')
  drawStarfield(ctx, stars)

  for (const entity of renderState.entities) {
    switch (entity.kind) {
      case 'ship':
        drawShip(ctx, entity, spriteSheet)
        break
      case 'bullet':
        drawBullet(ctx, entity, spriteSheet)
        break
      case 'asteroid':
        drawAsteroid(ctx, entity, spriteSheet)
        break
      case 'pickup':
        drawPickup(ctx, entity, spriteSheet)
        break
      default:
        assertNever(entity)
    }
  }

  for (const explosion of renderState.explosions) {
    drawExplosion(ctx, explosion)
  }

  ctx.strokeStyle = '#334155'
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, WORLD_WIDTH - 2, WORLD_HEIGHT - 2)
  ctx.restore()
}

function drawSpriteCell(
  ctx: CanvasRenderingContext2D,
  sheet: HTMLImageElement,
  cellIndex: number,
  drawSize: number,
): void {
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

function drawShip(
  ctx: CanvasRenderingContext2D,
  ship: RenderShip,
  sheet: HTMLImageElement | null,
): void {
  ctx.save()
  ctx.translate(ship.x, ship.y)

  ctx.font = 'bold 12px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = ship.isLocal ? '#38bdf8' : '#4ade80'
  ctx.fillText(ship.name, 0, -28)

  const hpRatio = Math.max(0, Math.min(1, ship.hp / 100))
  ctx.fillStyle = 'rgba(15, 23, 42, 0.85)'
  ctx.fillRect(-18, -22, 36, 4)
  ctx.fillStyle = hpRatio > 0.35 ? '#4ade80' : '#f87171'
  ctx.fillRect(-18, -22, 36 * hpRatio, 4)

  ctx.rotate(ship.angle)

  if (ship.thrusting) {
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
    ctx.fillStyle = ship.isLocal ? '#e5e7eb' : '#86efac'
    ctx.beginPath()
    ctx.moveTo(16, 0)
    ctx.lineTo(-12, -10)
    ctx.lineTo(-6, 0)
    ctx.lineTo(-12, 10)
    ctx.closePath()
    ctx.fill()
  }

  if (!ship.isLocal) {
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.65)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(0, 0, ship.radius + 5, 0, Math.PI * 2)
    ctx.stroke()
  }

  if (ship.shieldActive) {
    ctx.strokeStyle = '#38bdf8'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(0, 0, ship.radius + 9, 0, Math.PI * 2)
    ctx.stroke()
  }

  ctx.restore()
}

function drawBullet(
  ctx: CanvasRenderingContext2D,
  bullet: RenderBullet,
  sheet: HTMLImageElement | null,
): void {
  ctx.save()
  ctx.translate(bullet.x, bullet.y)
  ctx.rotate(bullet.angle)
  if (bullet.predicted) ctx.globalAlpha = 0.85
  if (sheet) {
    drawSpriteCell(ctx, sheet, bullet.isHoming ? 5 : 4, bullet.isHoming ? 22 : 16)
  } else {
    ctx.fillStyle = bullet.isHoming ? '#c084fc' : '#facc15'
    ctx.beginPath()
    if (bullet.isHoming) {
      ctx.moveTo(8, 0)
      ctx.lineTo(-5, -4)
      ctx.lineTo(-5, 4)
      ctx.closePath()
    } else {
      ctx.arc(0, 0, 4, 0, Math.PI * 2)
    }
    ctx.fill()
  }
  ctx.restore()
}

function drawAsteroid(
  ctx: CanvasRenderingContext2D,
  asteroid: RenderAsteroid,
  sheet: HTMLImageElement | null,
): void {
  ctx.save()
  ctx.translate(asteroid.x, asteroid.y)
  ctx.rotate(asteroid.angle)

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

function drawPickup(
  ctx: CanvasRenderingContext2D,
  pickup: RenderPickup,
  sheet: HTMLImageElement | null,
): void {
  const isShield = pickup.effect === 'shield'
  ctx.save()
  ctx.translate(pickup.x, pickup.y)
  ctx.rotate(pickup.angle)

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

function drawExplosion(
  ctx: CanvasRenderingContext2D,
  explosion: RenderExplosion,
): void {
  const ratio = Math.max(0, explosion.ttl / explosion.maxTtl)
  ctx.save()
  ctx.globalAlpha = ratio
  ctx.fillStyle = explosion.color
  ctx.beginPath()
  const particles = explosion.particles
  for (let i = 0; i < particles.length; i += 1) {
    const p = particles[i]
    if (!p) continue
    const r = p.r * ratio
    ctx.moveTo(p.x + r, p.y)
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
  }
  ctx.fill()
  ctx.restore()
}
