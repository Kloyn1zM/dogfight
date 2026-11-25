import type { LoopStats } from '../loop.ts'
import type { NetWorld } from '../net/netWorld.ts'

interface HudNotice {
  readonly text: string
  readonly color: string
  ttl: number
  readonly maxTtl: number
}

export interface HudController {
  draw(
    ctx: CanvasRenderingContext2D,
    stats: LoopStats,
    opts?: {
      playerName?: string
      roomName?: string
      muted?: boolean
      perfText?: string | null
    },
  ): void
  destroy(): void
}

export function createHud(netWorld: NetWorld): HudController {
  const notices: HudNotice[] = []

  const pushNotice = (text: string, color: string) => {
    notices.push({ text, color, ttl: 1.35, maxTtl: 1.35 })
    if (notices.length > 5) notices.shift()
  }

  const offs = [
    netWorld.events.on('score', ({ delta }) => {
      if (delta > 0) pushNotice(`+${delta} SCORE`, '#facc15')
    }),
    netWorld.events.on('pickup', ({ effect }) => {
      const label = effect === 'shield' ? 'SHIELD ONLINE' : 'RAPID FIRE!'
      const color = effect === 'shield' ? '#38bdf8' : '#f59e0b'
      pushNotice(label, color)
    }),
    netWorld.events.on('exploded', ({ kind }) => {
      if (kind === 'ship') pushNotice('SHIP DESTROYED', '#f87171')
    }),
  ]

  function draw(
    ctx: CanvasRenderingContext2D,
    stats: LoopStats,
    {
      playerName = 'Pilot',
      roomName = 'Arena',
      muted = false,
      perfText = null,
    }: {
      playerName?: string
      roomName?: string
      muted?: boolean
      perfText?: string | null
    } = {},
  ): void {
    const dt = Math.min((stats.frameTimeMs || 16.67) / 1000, 0.1)
    for (let i = notices.length - 1; i >= 0; i -= 1) {
      const n = notices[i]
      if (!n) continue
      n.ttl -= dt
      if (n.ttl <= 0) notices.splice(i, 1)
    }

    const ship = netWorld.getLocalShip()

    ctx.fillStyle = '#e5e7eb'
    ctx.font = '14px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillText(`steps/s   ${stats.stepsPerSecond} (30 Hz net)`, 20, 30)
    ctx.fillText(`frames/s  ${stats.framesPerSecond}`, 20, 50)
    ctx.fillText(`frame ms  ${stats.frameTimeMs.toFixed(2)}`, 20, 70)

    ctx.fillStyle = '#38bdf8'
    ctx.fillText(`${playerName} @ ${roomName}`, 20, 98)

    if (ship) {
      ctx.fillStyle = '#facc15'
      ctx.fillText(`SCORE     ${ship.score}`, 20, 120)

      if (ship.alive) {
        ctx.fillStyle = ship.hp > 35 ? '#4ade80' : '#f87171'
        ctx.fillText(`HP        ${ship.hp}/100`, 20, 140)
        if (ship.shieldTimer > 0) {
          ctx.fillStyle = '#38bdf8'
          ctx.fillText('SHIELD ACTIVE', 20, 160)
        }
        if (ship.rapidFireTimer > 0) {
          ctx.fillStyle = '#f59e0b'
          ctx.fillText('RAPID FIRE', 20, ship.shieldTimer > 0 ? 180 : 160)
        }
      } else {
        ctx.fillStyle = '#f87171'
        ctx.fillText('DESTROYED — RESPAWNING...', 20, 140)
      }
    } else {
      ctx.fillStyle = '#94a3b8'
      ctx.fillText('Очікуємо снапшот сервера...', 20, 120)
    }

    const centerX = ctx.canvas.clientWidth / 2
    ctx.save()
    ctx.textAlign = 'center'
    notices.forEach((n, idx) => {
      ctx.globalAlpha = Math.max(0, n.ttl / n.maxTtl)
      ctx.fillStyle = n.color
      ctx.fillText(n.text, centerX, 34 + idx * 22)
    })
    ctx.restore()

    if (perfText) {
      ctx.fillStyle = '#a78bfa'
      ctx.fillText(perfText, 20, ctx.canvas.clientHeight - 40)
    }

    ctx.fillStyle = '#9ca3af'
    ctx.fillText(
      `W/A/D — політ · Пробіл/Клік — постріл · E — homing · M — звук(${muted ? 'OFF' : 'ON'}) · Esc — лобі`,
      20,
      ctx.canvas.clientHeight - 18,
    )
  }

  function destroy(): void {
    for (const off of offs) off()
    notices.length = 0
  }

  return { draw, destroy }
}
