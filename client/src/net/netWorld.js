import {
  BULLET_RADIUS,
  FIRE_COOLDOWN,
  HOMING_COOLDOWN,
  RAPID_FIRE_COOLDOWN,
  TICK_DT,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  cloneShipState,
  createShipState,
  integrateShip,
  normalizeAngle,
  shortestAngleDiff,
  wrapPosition,
} from '@dogfight/shared'

function lerp(a, b, t) {
  return a + (b - a) * t
}

function lerpAngle(from, to, t) {
  return normalizeAngle(from + shortestAngleDiff(from, to) * t)
}

function wrapDelta(delta, size) {
  let d = delta
  if (d > size / 2) d -= size
  else if (d < -size / 2) d += size
  return d
}

/**
 * Клієнтський стан мультиплеєрного матчу:
 * - Локальний корабель: client-side prediction + server reconciliation + smoothing.
 * - Локальні кулі: миттєвий локальний спаун до приходу авторитетної кулі з сервера.
 * - Чужі кораблі, астероїди, кулі, бонуси: інтерполяція в минулому (now - interpolationDelayMs).
 */
export class NetWorld {
  #snapshotBuffer = []
  #pendingInputs = []
  #predictedBullets = []
  #explosions = []
  #rosterByShipId = new Map()

  #localShip = null
  #prevLocalShip = null
  #errorX = 0
  #errorY = 0
  #errorAngle = 0

  #nextSeq = 1
  #nextTempBulletId = 1
  #latestServerTick = 0
  #lastSnapshotAt = 0
  #lastScore = 0
  #lastCorrectionPx = 0
  #maxCorrectionPx = 0

  constructor() {
    this.events = new EventTarget()
    this.myShipId = null
    this.predictionEnabled = true
    this.interpolationDelayMs = 80
    // Тумблер для експерименту M2 (навмисне порушення детермінізму в prediction)
    this.breakDeterminism = false
  }

  reset() {
    this.#snapshotBuffer.length = 0
    this.#pendingInputs.length = 0
    this.#predictedBullets.length = 0
    this.#explosions.length = 0
    this.#rosterByShipId.clear()

    this.myShipId = null
    this.#localShip = null
    this.#prevLocalShip = null
    this.#errorX = 0
    this.#errorY = 0
    this.#errorAngle = 0
    this.#nextSeq = 1
    this.#latestServerTick = 0
    this.#lastSnapshotAt = 0
    this.#lastScore = 0
    this.#lastCorrectionPx = 0
    this.#maxCorrectionPx = 0
  }

  emit(type, detail = {}) {
    this.events.dispatchEvent(new CustomEvent(type, { detail }))
  }

  setWelcome({ shipId, tick }) {
    this.myShipId = shipId
    this.#latestServerTick = tick || 0
    this.#pendingInputs.length = 0
    this.#predictedBullets.length = 0
    this.#localShip = null
    this.#prevLocalShip = null
    this.#errorX = 0
    this.#errorY = 0
    this.#errorAngle = 0
    this.#lastScore = 0
  }

  setRoster(players) {
    this.#rosterByShipId.clear()
    for (const p of players || []) {
      if (typeof p.shipId === 'number') {
        this.#rosterByShipId.set(p.shipId, p.name)
      }
    }
  }

  getPlayerName(shipId) {
    return this.#rosterByShipId.get(shipId) || `Pilot #${shipId}`
  }

  getLocalShip() {
    return this.#localShip
  }

  getMetrics(now = performance.now()) {
    const snapshotAgeMs =
      this.#lastSnapshotAt > 0 ? Math.max(0, now - this.#lastSnapshotAt) : 0
    return {
      tick: this.#latestServerTick,
      snapshotAgeMs,
      pendingInputs: this.#pendingInputs.length,
      lastCorrectionPx: this.#lastCorrectionPx,
      maxCorrectionPx: this.#maxCorrectionPx,
      bufferSize: this.#snapshotBuffer.length,
    }
  }

  resetCorrectionPeak() {
    this.#maxCorrectionPx = 0
  }

  /**
   * Викликається на кожному 30 Hz кроці клієнтської симуляції.
   * Повертає сформовану команду з seq для відправки на сервер.
   */
  stepLocal(command, dt = TICK_DT) {
    // 1. Згладжуємо залишкову помилку реконсиліації (~80–100 ms)
    const smoothFactor = Math.exp(-dt / 0.085)
    this.#errorX *= smoothFactor
    this.#errorY *= smoothFactor
    this.#errorAngle *= smoothFactor
    if (Math.abs(this.#errorX) < 0.05) this.#errorX = 0
    if (Math.abs(this.#errorY) < 0.05) this.#errorY = 0
    if (Math.abs(this.#errorAngle) < 0.001) this.#errorAngle = 0

    // 2. Оновлюємо локальні візуальні вибухи
    const drag = Math.exp(-3.2 * dt)
    for (let i = this.#explosions.length - 1; i >= 0; i -= 1) {
      const ex = this.#explosions[i]
      for (const p of ex.particles) {
        p.vx *= drag
        p.vy *= drag
        p.x += p.vx * dt
        p.y += p.vy * dt
      }
      ex.ttl -= dt
      if (ex.ttl <= 0) this.#explosions.splice(i, 1)
    }

    // 3. Оновлюємо локально передбачені кулі
    for (let i = this.#predictedBullets.length - 1; i >= 0; i -= 1) {
      const b = this.#predictedBullets[i]
      b.prevX = b.x
      b.prevY = b.y
      b.x += b.vx * dt
      b.y += b.vy * dt
      wrapPosition(b, WORLD_WIDTH, WORLD_HEIGHT)
      b.ttl -= dt
      if (b.ttl <= 0) this.#predictedBullets.splice(i, 1)
    }

    if (this.myShipId === null) return null

    const input = {
      seq: this.#nextSeq++,
      tick: this.#latestServerTick + 1,
      turn: command.turn,
      thrust: Boolean(command.thrust),
      fire: Boolean(command.fire),
      fireHoming: Boolean(command.fireHoming),
    }

    if (this.#localShip) {
      this.#prevLocalShip = cloneShipState(this.#localShip)

      if (this.predictionEnabled && this.#localShip.alive) {
        this.#pendingInputs.push(input)
        if (this.#pendingInputs.length > 90) {
          this.#pendingInputs.shift()
        }

        this.#integrateWithOptionalBug(this.#localShip, input, dt)

        // Локальне передбачення власного пострілу (миттєвий відгук)
        if (input.fire && this.#localShip.fireCooldown === 0) {
          this.#spawnPredictedBullet(this.#localShip, false)
          this.#localShip.fireCooldown =
            this.#localShip.rapidFireTimer > 0
              ? RAPID_FIRE_COOLDOWN
              : FIRE_COOLDOWN
        }
        if (input.fireHoming && this.#localShip.homingCooldown === 0) {
          this.#spawnPredictedBullet(this.#localShip, true)
          this.#localShip.homingCooldown = HOMING_COOLDOWN
        }
      }
    }

    return input
  }

  onSnapshot(snapshot, receivedAt = performance.now()) {
    if (snapshot.tick < this.#latestServerTick) {
      // Ігноруємо застарілі пакети, що прийшли не по порядку
      return
    }

    this.#latestServerTick = snapshot.tick
    this.#lastSnapshotAt = receivedAt

    const byId = new Map()
    for (const e of snapshot.entities) {
      byId.set(e.id, e)
    }

    this.#snapshotBuffer.push({ receivedAt, snapshot, byId })
    while (this.#snapshotBuffer.length > 24) {
      this.#snapshotBuffer.shift()
    }

    if (this.myShipId === null) return

    // Знімаємо передбачені кулі, якщо авторитетний сервер уже створив відповідну кулю
    for (let i = this.#predictedBullets.length - 1; i >= 0; i -= 1) {
      const pb = this.#predictedBullets[i]
      const matched = snapshot.entities.some((e) => {
        if (e.kind !== 'bullet' || e.ownerId !== this.myShipId) return false
        const dx = wrapDelta(e.x - pb.x, WORLD_WIDTH)
        const dy = wrapDelta(e.y - pb.y, WORLD_HEIGHT)
        return dx * dx + dy * dy <= 95 * 95
      })
      if (matched) this.#predictedBullets.splice(i, 1)
    }

    const serverShip = byId.get(this.myShipId)
    if (!serverShip || serverShip.kind !== 'ship') return

    // Сповіщаємо HUD про зростання рахунку
    if (serverShip.score > this.#lastScore) {
      this.emit('score', {
        delta: serverShip.score - this.#lastScore,
        total: serverShip.score,
      })
    }
    this.#lastScore = serverShip.score

    // Перший снапшот після входу
    if (!this.#localShip) {
      this.#localShip = createShipState({
        id: serverShip.id,
        x: serverShip.x,
        y: serverShip.y,
        angle: serverShip.angle,
      })
      this.#applyAuthoritativeShip(this.#localShip, serverShip)
      this.#prevLocalShip = cloneShipState(this.#localShip)
      return
    }

    const wasAlive = this.#localShip.alive
    const prevVisX = this.#localShip.x + this.#errorX
    const prevVisY = this.#localShip.y + this.#errorY
    const prevVisAngle = normalizeAngle(
      this.#localShip.angle + this.#errorAngle,
    )

    // 1. Відкидаємо команди, які сервер уже обробив (<= lastProcessedSeq)
    const ackSeq = snapshot.lastProcessedSeq || 0
    while (
      this.#pendingInputs.length > 0 &&
      this.#pendingInputs[0].seq <= ackSeq
    ) {
      this.#pendingInputs.shift()
    }

    // 2. Встановлюємо авторитетний стан сервера
    this.#applyAuthoritativeShip(this.#localShip, serverShip)

    if (!this.#localShip.alive) {
      this.#pendingInputs.length = 0
      this.#errorX = 0
      this.#errorY = 0
      this.#errorAngle = 0
      this.#lastCorrectionPx = 0
      this.#prevLocalShip = cloneShipState(this.#localShip)
      return
    }

    // Щойно відродився після смерті — телепортуємо без згладжування
    if (!wasAlive && this.#localShip.alive) {
      this.#pendingInputs.length = 0
      this.#errorX = 0
      this.#errorY = 0
      this.#errorAngle = 0
      this.#lastCorrectionPx = 0
      this.#prevLocalShip = cloneShipState(this.#localShip)
      return
    }

    // 3. Server Reconciliation: програємо поверх усі непідтверджені команди
    if (this.predictionEnabled) {
      for (const inp of this.#pendingInputs) {
        this.#integrateWithOptionalBug(this.#localShip, inp, TICK_DT)
      }

      const dx = wrapDelta(prevVisX - this.#localShip.x, WORLD_WIDTH)
      const dy = wrapDelta(prevVisY - this.#localShip.y, WORLD_HEIGHT)
      const corr = Math.hypot(dx, dy)
      this.#lastCorrectionPx = corr
      if (corr > this.#maxCorrectionPx) this.#maxCorrectionPx = corr

      if (corr > 0.2 && corr < 220) {
        this.#errorX = dx
        this.#errorY = dy
        this.#errorAngle = shortestAngleDiff(
          this.#localShip.angle,
          prevVisAngle,
        )
      } else {
        this.#errorX = 0
        this.#errorY = 0
        this.#errorAngle = 0
      }
    } else {
      this.#lastCorrectionPx = 0
      this.#errorX = 0
      this.#errorY = 0
      this.#errorAngle = 0
    }

    this.#prevLocalShip = cloneShipState(this.#localShip)
  }

  onServerEvents(events) {
    for (const evt of events || []) {
      if (evt.type === 'fired') {
        this.emit('fired', { homing: evt.homing, ownerId: evt.ownerId })
      } else if (evt.type === 'hit') {
        this.emit('hit', evt)
      } else if (evt.type === 'pickup') {
        if (evt.shipId === this.myShipId) {
          this.emit('pickup', { effect: evt.effect })
        }
      } else if (evt.type === 'exploded') {
        this.emit('exploded', evt)
        this.#spawnExplosion({
          x: evt.x,
          y: evt.y,
          big: Boolean(evt.big),
          color: evt.kind === 'ship' ? '#ef4444' : '#fb923c',
        })
      }
    }
  }

  /**
   * Формує список сутностей для рендеру на поточний кадр дисплея:
   * - локальний корабель інтерполюється між prevLocalShip і localShip за alpha (+ smoothing);
   * - усі інші сутності інтерполюються між двома снапшотами в минулому (now - interpolationDelayMs).
   */
  getRenderState(now, alpha) {
    const entities = []

    // 1. Локальний корабель (якщо prediction увімкнений)
    if (
      this.predictionEnabled &&
      this.#localShip &&
      this.#localShip.alive &&
      this.#prevLocalShip
    ) {
      const wrapX =
        Math.abs(this.#localShip.x - this.#prevLocalShip.x) > WORLD_WIDTH / 2
      const wrapY =
        Math.abs(this.#localShip.y - this.#prevLocalShip.y) > WORLD_HEIGHT / 2

      const baseX = wrapX
        ? this.#localShip.x
        : lerp(this.#prevLocalShip.x, this.#localShip.x, alpha)
      const baseY = wrapY
        ? this.#localShip.y
        : lerp(this.#prevLocalShip.y, this.#localShip.y, alpha)
      const baseAngle = lerpAngle(
        this.#prevLocalShip.angle,
        this.#localShip.angle,
        alpha,
      )

      const x =
        (((baseX + this.#errorX) % WORLD_WIDTH) + WORLD_WIDTH) % WORLD_WIDTH
      const y =
        (((baseY + this.#errorY) % WORLD_HEIGHT) + WORLD_HEIGHT) % WORLD_HEIGHT
      const angle = normalizeAngle(baseAngle + this.#errorAngle)

      entities.push({
        id: this.#localShip.id,
        kind: 'ship',
        isLocal: true,
        name: this.getPlayerName(this.#localShip.id),
        x,
        y,
        angle,
        radius: 14,
        thrusting: this.#localShip.thrust > 0,
        shieldActive: this.#localShip.shieldTimer > 0,
        rapidFireActive: this.#localShip.rapidFireTimer > 0,
        alive: true,
        hp: this.#localShip.hp,
        score: this.#localShip.score,
      })
    }

    // 2. Чужі сутності (інтерполяція в минулому)
    const buf = this.#snapshotBuffer
    if (buf.length > 0) {
      const renderTime = now - this.interpolationDelayMs
      let s0 = buf[0]
      let s1 = buf[buf.length - 1]

      if (renderTime <= buf[0].receivedAt) {
        s0 = buf[0]
        s1 = buf[0]
      } else if (renderTime >= buf[buf.length - 1].receivedAt) {
        s0 = buf[buf.length - 1]
        s1 = buf[buf.length - 1]
      } else {
        for (let i = 0; i < buf.length - 1; i += 1) {
          if (
            buf[i].receivedAt <= renderTime &&
            buf[i + 1].receivedAt >= renderTime
          ) {
            s0 = buf[i]
            s1 = buf[i + 1]
            break
          }
        }
      }

      const span = s1.receivedAt - s0.receivedAt
      const t =
        span > 0.001
          ? Math.max(0, Math.min(1, (renderTime - s0.receivedAt) / span))
          : 1

      for (const e1 of s1.snapshot.entities) {
        if (
          this.predictionEnabled &&
          e1.kind === 'ship' &&
          e1.id === this.myShipId
        ) {
          continue
        }
        if (e1.kind === 'ship' && !e1.alive) continue

        const e0 = s0.byId.get(e1.id)
        let x = e1.x
        let y = e1.y
        let angle = e1.angle

        if (e0 && e0.kind === e1.kind) {
          if (Math.abs(e1.x - e0.x) <= WORLD_WIDTH / 2) {
            x = lerp(e0.x, e1.x, t)
          }
          if (Math.abs(e1.y - e0.y) <= WORLD_HEIGHT / 2) {
            y = lerp(e0.y, e1.y, t)
          }
          angle = lerpAngle(e0.angle, e1.angle, t)
        }

        if (e1.kind === 'ship') {
          entities.push({
            ...e1,
            isLocal: e1.id === this.myShipId,
            name: this.getPlayerName(e1.id),
            x,
            y,
            angle,
            radius: 14,
          })
        } else {
          entities.push({ ...e1, x, y, angle })
        }
      }
    }

    // 3. Локально передбачені кулі
    for (const pb of this.#predictedBullets) {
      const wx = Math.abs(pb.x - pb.prevX) > WORLD_WIDTH / 2
      const wy = Math.abs(pb.y - pb.prevY) > WORLD_HEIGHT / 2
      entities.push({
        id: pb.tempId,
        kind: 'bullet',
        x: wx ? pb.x : lerp(pb.prevX, pb.x, alpha),
        y: wy ? pb.y : lerp(pb.prevY, pb.y, alpha),
        angle: pb.angle,
        isHoming: pb.isHoming,
        predicted: true,
      })
    }

    return {
      entities,
      explosions: this.#explosions,
    }
  }

  #integrateWithOptionalBug(ship, input, dt) {
    integrateShip(ship, input, dt, WORLD_WIDTH, WORLD_HEIGHT)
    if (this.breakDeterminism && input.thrust) {
      // Навмисна ін'єкція Math.random() для експерименту Lab 5 M2
      ship.x += (Math.random() - 0.5) * 28
      ship.y += (Math.random() - 0.5) * 28
      wrapPosition(ship, WORLD_WIDTH, WORLD_HEIGHT)
    }
  }

  #applyAuthoritativeShip(target, s) {
    target.x = s.x
    target.y = s.y
    target.vx = s.vx
    target.vy = s.vy
    target.angle = s.angle
    target.hp = s.hp
    target.score = s.score
    target.alive = s.alive
    target.thrust = s.thrusting ? 520 : 0
    target.shieldTimer = s.shieldActive ? 1 : 0
    target.rapidFireTimer = s.rapidFireActive ? 1 : 0
  }

  #spawnPredictedBullet(ship, isHoming) {
    const cos = Math.cos(ship.angle)
    const sin = Math.sin(ship.angle)
    const speed = isHoming ? 340 : 540
    const x = ship.x + cos * (ship.radius + 6)
    const y = ship.y + sin * (ship.radius + 6)
    this.#predictedBullets.push({
      tempId: `pred-${this.#nextTempBulletId++}`,
      x,
      y,
      prevX: x,
      prevY: y,
      vx: ship.vx + cos * speed,
      vy: ship.vy + sin * speed,
      angle: ship.angle,
      radius: BULLET_RADIUS,
      isHoming,
      ttl: 0.28,
    })
  }

  #spawnExplosion({ x, y, big = false, color = '#fb923c' }) {
    const count = big ? 20 : 10
    const speed = big ? 220 : 150
    const particles = []
    for (let i = 0; i < count; i += 1) {
      const a = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4
      const spd = speed * (0.35 + Math.random() * 0.75)
      particles.push({
        x,
        y,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd,
        r: 1.5 + Math.random() * 2.5,
      })
    }
    this.#explosions.push({
      ttl: 0.5,
      maxTtl: 0.5,
      color,
      particles,
    })
  }
}
