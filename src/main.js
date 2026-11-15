import './style.css'
import { createLoop } from './loop.js'
import { createInput, readShipCommand } from './input.js'
import { cloneShip, copyShip, createShip, integrate } from './sim/ship.js'
import { createArena, hideWrapForLerp, wrap } from './sim/arena.js'
import { createCanvas } from './render/canvas.js'
import {
  createStarfield,
  drawBackground,
  drawGrid,
  drawHud,
  drawShip,
  drawStarfield,
  interpolateShip,
} from './render/draw.js'

const input = createInput(window)
const arena = createArena()
const ship = createShip()
const previous = cloneShip(ship)
const command = { turn: 0, thrust: false }
const renderShip = { x: 0, y: 0, angle: 0, thrust: 0 }

let stars = []
let lastAlpha = 0

function resetShipToCenter() {
  ship.x = arena.width / 2
  ship.y = arena.height / 2
  ship.vx = 0
  ship.vy = 0
  ship.angle = -Math.PI / 2
  ship.thrust = 0
  copyShip(previous, ship)
}

const { ctx, size } = createCanvas(document.querySelector('#game'), {
  onResize({ w, h }) {
    arena.width = w
    arena.height = h
    wrap(ship, arena)
    copyShip(previous, ship)
    stars = createStarfield(w, h)
  },
})

resetShipToCenter()

function simulate(dt) {
  copyShip(previous, ship)

  if (input.justPressed('KeyR')) {
    resetShipToCenter()
  }

  readShipCommand(input, command)
  integrate(ship, command, dt)
  wrap(ship, arena)
  hideWrapForLerp(previous, ship, arena)
  input.consume()
}

function render(alpha, stats, paused = false) {
  lastAlpha = alpha
  drawBackground(ctx, size.w, size.h)
  drawGrid(ctx, size.w, size.h)
  drawStarfield(ctx, stars)
  drawShip(ctx, interpolateShip(previous, ship, alpha, renderShip))
  drawHud(ctx, stats, { paused })
}

const loop = createLoop({
  simulate,
  render: (alpha, stats) => render(alpha, stats, false),
})
loop.start()

// У Lab 1 Пробіл — пауза; у Lab 2 перенесемо паузу на KeyP, а Пробіл віддамо під стрільбу.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return
  e.preventDefault()

  if (loop.isRunning()) {
    loop.stop()
    render(lastAlpha, loop.getStats(), true)
  } else {
    loop.start()
  }
})
