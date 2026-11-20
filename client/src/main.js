import './style.css'
import { createLoop } from './loop.js'
import { createInput, isEditableTarget, readShipCommand } from './input.js'
import { createArena } from './sim/arena.js'
import { World } from './sim/world.js'
import { createCanvas } from './render/canvas.js'
import {
  createStarfield,
  drawBackground,
  drawGrid,
  drawLoadingScreen,
  drawStarfield,
  drawWorld,
} from './render/draw.js'
import { createHud } from './render/hud.js'
import { createAudioManager } from './audio.js'
import { loadAll, loadJson } from './assets/loader.js'
import { Lobby } from './lobby/lobby.js'
import { mountLobbyView } from './lobby/lobbyView.js'
import { GameConnection } from './net/connection.js'
import { mountRoomPanel } from './ui/roomPanel.js'

const canvasEl = document.querySelector('#game')
const lobbyOverlay = document.querySelector('#lobby-overlay')
const loadingControls = document.querySelector('#loading-controls')
const roomPanelEl = document.querySelector('#room-panel')

const params = new URLSearchParams(window.location.search)
const devDelayMs = Number(params.get('delay') || 0)
const devSequential = params.get('seq') === '1'
const devFailMode = params.get('fail') || ''

const input = createInput(window)
const arena = createArena()
const world = new World(arena)
const hud = createHud(world)
const audio = createAudioManager()
audio.attachWorld(world)

const connection = new GameConnection()
const roomPanel = mountRoomPanel(roomPanelEl, connection)

const command = { turn: 0, thrust: false, fire: false, fireHoming: false }

let stars = []
let lastAlpha = 0
let mode = 'lobby' // 'lobby' | 'loading' | 'playing'
let activeRoom = null
let activePlayerName = 'Pilot'
let loadedAssets = { sprites: {}, sounds: {}, arena: null }
let loadController = null
let loadingState = { ratio: 0, label: '', error: null }

const { ctx, size } = createCanvas(canvasEl, {
  onResize({ w, h }) {
    arena.width = w
    arena.height = h
    stars = createStarfield(w, h)
  },
})

window.addEventListener('resize', () => {
  if (mode === 'loading') {
    drawLoadingScreen(ctx, size.w, size.h, loadingState)
  } else if (mode === 'lobby') {
    drawBackground(ctx, size.w, size.h)
    drawGrid(ctx, size.w, size.h)
    drawStarfield(ctx, stars)
  }
})

function simulate(dt) {
  if (input.justPressed('KeyR')) {
    world.reset(activeRoom?.arena)
  }

  readShipCommand(input, command)
  world.step(dt, command)
  input.consume()
}

function render(alpha, stats, paused = false) {
  lastAlpha = alpha
  const theme = activeRoom?.arena || loadedAssets.arena || {}
  drawBackground(ctx, size.w, size.h, theme.background)
  drawGrid(ctx, size.w, size.h, theme.gridColor)
  drawStarfield(ctx, stars)
  drawWorld(ctx, world, alpha, loadedAssets.sprites.sheet || null)
  hud.draw(ctx, stats, {
    paused,
    playerName: activePlayerName,
    roomName: activeRoom?.name || 'Arena',
    muted: audio.isMuted(),
  })
}

const loop = createLoop({
  simulate,
  render: (alpha, stats) => render(alpha, stats, false),
})

function setLoadingControls(html, handlers = {}) {
  loadingControls.innerHTML = html
  loadingControls.classList.toggle('hidden', !html)
  for (const [selector, fn] of Object.entries(handlers)) {
    const el = loadingControls.querySelector(selector)
    if (el) el.addEventListener('click', fn)
  }
}

function startPlaying(assets) {
  loadedAssets = assets
  audio.setBuffers(assets.sounds)
  setLoadingControls('')
  mode = 'playing'
  world.reset(activeRoom?.arena || assets.arena)
  roomPanel.show(activeRoom?.name)
  if (activeRoom) {
    connection.connect({ room: activeRoom.id, name: activePlayerName })
  }
  loop.start()
}

async function beginLoadingAndPlay({ ignoreDevFail = false } = {}) {
  mode = 'loading'
  loop.stop()
  loadController?.abort()
  loadController = new AbortController()

  loadingState = { ratio: 0, label: 'manifest.json', error: null }
  drawLoadingScreen(ctx, size.w, size.h, loadingState)

  setLoadingControls(
    '<button id="btn-abort" type="button">Скасувати (Abort)</button>',
    {
      '#btn-abort': () => {
        loadController?.abort(
          new DOMException('Скасовано користувачем', 'AbortError'),
        )
      },
    },
  )

  try {
    const manifest = await loadJson('/assets/manifest.json', {
      signal: loadController.signal,
      timeoutMs: 4000,
    })

    const testManifest = structuredClone(manifest)
    let timeoutMs = 5000
    if (!ignoreDevFail && devFailMode === '404') {
      testManifest.sprites.sheet = '/assets/does-not-exist-404.svg'
    } else if (!ignoreDevFail && devFailMode === 'timeout') {
      testManifest.arena = '/api/dev-timeout'
      timeoutMs = 1200
    } else if (!ignoreDevFail && devFailMode === 'corrupt') {
      testManifest.arena = '/api/dev-corrupt.json'
    }

    const assets = await loadAll(testManifest, {
      audioCtx: audio.ctx,
      signal: loadController.signal,
      timeoutMs,
      delayMs: devDelayMs,
      sequential: devSequential,
      onProgress(p) {
        loadingState = { ratio: p.ratio, label: p.label, error: null }
        drawLoadingScreen(ctx, size.w, size.h, loadingState)
      },
    })

    startPlaying(assets)
  } catch (err) {
    console.warn('[Loader] failed:', err.name, err.message)
    loadingState = {
      ratio: loadingState.ratio,
      label: '',
      error: `${err.name}: ${err.message}`,
    }
    drawLoadingScreen(ctx, size.w, size.h, loadingState)

    setLoadingControls(
      `
        <button id="btn-retry" type="button">Повторити (чистий маніфест)</button>
        <button id="btn-fallback" type="button">Грати без асетів (fallback)</button>
        <button id="btn-back" type="button">Назад у лобі</button>
      `,
      {
        '#btn-retry': () => beginLoadingAndPlay({ ignoreDevFail: true }),
        '#btn-fallback': () =>
          startPlaying({ sprites: {}, sounds: {}, arena: activeRoom?.arena }),
        '#btn-back': () => returnToLobby(),
      },
    )
  }
}

const lobby = new Lobby({ endpoint: '/api/rooms' })
const lobbyView = mountLobbyView(lobbyOverlay, lobby)

function returnToLobby() {
  loadController?.abort()
  connection.disconnect()
  roomPanel.hide()
  loop.stop()
  input.clear()
  setLoadingControls('')
  mode = 'lobby'
  drawBackground(ctx, size.w, size.h)
  drawGrid(ctx, size.w, size.h)
  drawStarfield(ctx, stars)
  lobbyView.show()
  lobby.startPolling(5000)
}

lobby.addEventListener('joined', async (e) => {
  activeRoom = e.detail.room
  activePlayerName = e.detail.playerName
  await audio.unlock()
  await beginLoadingAndPlay()
})

returnToLobby()

canvasEl.addEventListener('pointerdown', (e) => {
  if (mode !== 'playing' || e.button !== 0 || !loop.isRunning()) return
  const player = world.getPlayer()
  if (player) player.fire(world)
})

window.addEventListener('keydown', (e) => {
  if (isEditableTarget(e.target)) return
  if (mode !== 'playing' || e.repeat) return

  if (e.code === 'KeyP') {
    e.preventDefault()
    if (loop.isRunning()) {
      loop.stop()
      render(lastAlpha, loop.getStats(), true)
    } else {
      loop.start()
    }
  } else if (e.code === 'KeyM') {
    audio.toggleMute()
  } else if (e.code === 'Escape') {
    returnToLobby()
  }
})
