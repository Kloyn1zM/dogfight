import './style.css'
import { createLoop } from './loop.js'
import { createInput, readShipCommand } from './input.js'
import { createArena } from './sim/arena.js'
import { World } from './sim/world.js'
import { createCanvas } from './render/canvas.js'
import {
  createStarfield,
  drawBackground,
  drawGrid,
  drawHud,
  drawStarfield,
  drawWorld,
} from './render/draw.js'

const canvasEl = document.querySelector('#game')
const input = createInput(window)
const arena = createArena()
const world = new World(arena)
const command = { turn: 0, thrust: false, fire: false, fireHoming: false }

let stars = []
let lastAlpha = 0

const { ctx, size } = createCanvas(canvasEl, {
  onResize({ w, h }) {
    arena.width = w
    arena.height = h
    stars = createStarfield(w, h)
  },
})

world.reset()

function simulate(dt) {
  if (input.justPressed('KeyR')) {
    world.reset()
  }

  readShipCommand(input, command)
  world.step(dt, command)
  input.consume()
}

function render(alpha, stats, paused = false) {
  lastAlpha = alpha
  drawBackground(ctx, size.w, size.h)
  drawGrid(ctx, size.w, size.h)
  drawStarfield(ctx, stars)
  drawWorld(ctx, world, alpha)
  drawHud(ctx, stats, world, { paused })
}

const loop = createLoop({
  simulate,
  render: (alpha, stats) => render(alpha, stats, false),
})
loop.start()

// Клік по canvas робить постріл.
// Наївне `canvasEl.addEventListener('pointerdown', player.fire)` ламає `this`
// (браузер викликає обробник із `this === canvasEl`), плюс втрачає зв'язок після респауну.
// Стрілкова обгортка щоразу викликає метод на поточному екземплярі корабля (implicit binding).
canvasEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !loop.isRunning()) return
  const player = world.getPlayer()
  if (player) player.fire(world)
})

window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyP' || e.repeat) return
  e.preventDefault()

  if (loop.isRunning()) {
    loop.stop()
    render(lastAlpha, loop.getStats(), true)
  } else {
    loop.start()
  }
})
