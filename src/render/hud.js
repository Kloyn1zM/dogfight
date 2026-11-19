/**
 * HUD-модуль: слухає події World через EventTarget (score, pickup, exploded)
 * і показує спливаючі сповіщення без жодних імпортів у src/sim/.
 */
export function createHud(world) {
  const notices = []

  const pushNotice = (text, color) => {
    notices.push({ text, color, ttl: 1.35, maxTtl: 1.35 })
    if (notices.length > 5) notices.shift()
  }

  const onScore = (e) => {
    const delta = e.detail?.delta || 0
    if (delta > 0) pushNotice(`+${delta} SCORE`, '#facc15')
  }
  const onPickup = (e) => {
    const label =
      e.detail?.effect === 'shield' ? 'SHIELD ONLINE' : 'RAPID FIRE!'
    const color = e.detail?.effect === 'shield' ? '#38bdf8' : '#f59e0b'
    pushNotice(label, color)
  }
  const onExploded = (e) => {
    if (e.detail?.kind === 'ship') pushNotice('SHIP DESTROYED', '#f87171')
  }

  world.events.addEventListener('score', onScore)
  world.events.addEventListener('pickup', onPickup)
  world.events.addEventListener('exploded', onExploded)

  function draw(
    ctx,
    stats,
    {
      paused = false,
      playerName = 'Pilot',
      roomName = 'Arena',
      muted = false,
    } = {},
  ) {
    const dt = Math.min((stats.frameTimeMs || 16.67) / 1000, 0.1)
    for (let i = notices.length - 1; i >= 0; i -= 1) {
      notices[i].ttl -= dt
      if (notices[i].ttl <= 0) notices.splice(i, 1)
    }

    const player = world.getPlayer()

    ctx.fillStyle = '#e5e7eb'
    ctx.font = '15px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillText(`steps/s   ${stats.stepsPerSecond}`, 24, 34)
    ctx.fillText(`frames/s  ${stats.framesPerSecond}`, 24, 56)
    ctx.fillText(`frame ms  ${stats.frameTimeMs.toFixed(2)}`, 24, 78)

    ctx.fillStyle = '#38bdf8'
    ctx.fillText(`${playerName} @ ${roomName}`, 24, 108)

    ctx.fillStyle = '#facc15'
    ctx.fillText(`SCORE     ${world.score}`, 24, 132)

    if (player && player.alive) {
      ctx.fillStyle = player.hp > 35 ? '#4ade80' : '#f87171'
      ctx.fillText(`HP        ${player.hp}/${player.maxHp}`, 24, 154)

      let buffY = 176
      if (player.shieldActive) {
        ctx.fillStyle = '#38bdf8'
        ctx.fillText(`SHIELD    ${player.shieldTimer.toFixed(1)}s`, 24, buffY)
        buffY += 22
      }
      if (player.rapidFireActive) {
        ctx.fillStyle = '#f59e0b'
        ctx.fillText(
          `RAPID     ${player.rapidFireTimer.toFixed(1)}s`,
          24,
          buffY,
        )
      }
    } else {
      ctx.fillStyle = '#f87171'
      ctx.fillText(`RESPAWN   ${world.respawnTimer.toFixed(1)}s`, 24, 154)
    }

    // Спливаючі події (справа вгорі)
    const rightX = ctx.canvas.clientWidth - 24
    ctx.save()
    ctx.textAlign = 'right'
    notices.forEach((n, idx) => {
      ctx.globalAlpha = Math.max(0, n.ttl / n.maxTtl)
      ctx.fillStyle = n.color
      ctx.fillText(n.text, rightX, 36 + idx * 24)
    })
    ctx.restore()

    ctx.fillStyle = '#9ca3af'
    ctx.fillText(
      `W/A/D — політ · Пробіл/Клік — постріл · E — homing · M — звук(${muted ? 'OFF' : 'ON'}) · P — пауза · Esc — лобі`,
      24,
      ctx.canvas.clientHeight - 24,
    )

    if (paused) {
      ctx.fillStyle = '#fb923c'
      ctx.font = 'bold 20px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.fillText('PAUSED', 24, 212)
    }
  }

  function destroy() {
    world.events.removeEventListener('score', onScore)
    world.events.removeEventListener('pickup', onPickup)
    world.events.removeEventListener('exploded', onExploded)
    notices.length = 0
  }

  return { draw, destroy }
}
