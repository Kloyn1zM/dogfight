import './style.css'
import {
  TICK_DT,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  createShipState,
  hashShipState,
  integrateShip,
} from '@dogfight/shared'
import { createLoop } from './loop.js'
import { createInput, isEditableTarget, readShipCommand } from './input.js'
import { createCanvas } from './render/canvas.js'
import {
  createStarfield,
  drawBackground,
  drawGrid,
  drawLoadingScreen,
  drawMultiplayerArena,
  drawStarfield,
} from './render/draw.js'
import { createHud } from './render/hud.js'
import { createAudioManager } from './audio.js'
import { loadAll, loadJson } from './assets/loader.js'
import { Lobby } from './lobby/lobby.js'
import { mountLobbyView } from './lobby/lobbyView.js'
import { GameConnection } from './net/connection.js'
import { NetWorld } from './net/netWorld.js'
import { mountRoomPanel } from './ui/roomPanel.js'
import { mountNetPanel } from './ui/netPanel.js'

// Перевірка детермінізму shared/ у браузері (має збігатися з Node.js до біта)
function logBrowserDeterminismHash() {
  const ship = createShipState({ id: 1, x: 640, y: 360, angle: -Math.PI / 2 })
  for (let i = 0; i < 1000; i += 1) {
    const turn = i % 30 < 10 ? 1 : i % 30 < 20 ? -1 : 0
    const thrust = i % 3 !== 0
    integrateShip(ship, { turn, thrust }, TICK_DT)
  }
  console.log('[Determinism] Browser 1000-step hash:', hashShipState(ship))
}
logBrowserDeterminismHash()

const canvasEl = document.querySelector('#game')
const lobbyOverlay = document.querySelector('#lobby-overlay')
const loadingControls = document.querySelector('#loading-controls')
const roomPanelEl = document.querySelector('#room-panel')
const netPanelEl = document.querySelector('#net-panel')

const params = new URLSearchParams(window.location.search)
const devDelayMs = Number(params.get('delay') || 0)
const devSequential = params.get('seq') === '1'
const devFailMode = params.get('fail') || ''

const input = createInput(window)
const netWorld = new NetWorld()
const hud = createHud(netWorld)
const audio = createAudioManager()
audio.attachWorld(netWorld)

const connection = new GameConnection()
const roomPanel = mountRoomPanel(roomPanelEl, connection)
const netPanel = mountNetPanel(netPanelEl, { connection, netWorld })

const command = { turn: 0, thrust: false, fire: false, fireHoming: false }
const arenaStars = createStarfield(WORLD_WIDTH, WORLD_HEIGHT, 160)

let bgStars = []
let mode = 'lobby' // 'lobby' | 'loading' | 'playing'
let activeRoom = null
let activePlayerName = 'Pilot'
let loadedAssets = { sprites: {}, sounds: {}, arena: null }
let loadController = null
let loadingState = { ratio: 0, label: '', error: null }
let pointerFirePending = false

const { ctx, size } = createCanvas(canvasEl, {
  onResize({ w, h }) {
    bgStars = createStarfield(w, h)
  },
})

window.addEventListener('resize', () => {
  if (mode === 'loading') {
    drawLoadingScreen(ctx, size.w, size.h, loadingState)
  } else if (mode === 'lobby') {
    drawBackground(ctx, size.w, size.h)
    drawGrid(ctx, size.w, size.h)
    drawStarfield(ctx, bgStars)
  }
})

// Підписки мережевого шару на події від сервера
connection.addEventListener('welcome', (e) => {
  netWorld.setWelcome({
    shipId: e.detail.shipId,
    tick: e.detail.tick,
  })
})

connection.addEventListener('roster', (e) => {
  netWorld.setRoster(e.detail.players)
})

connection.addEventListener('snapshot', (e) => {
  netWorld.onSnapshot(e.detail.snapshot, e.detail.receivedAt)
})

connection.addEventListener('events', (e) => {
  netWorld.onServerEvents(e.detail.events)
})

function simulate(dt) {
  readShipCommand(input, command)
  if (pointerFirePending) {
    command.fire = true
    pointerFirePending = false
  }

  const sentInput = netWorld.stepLocal(command, dt)
  if (sentInput) {
    connection.sendInput(sentInput)
  }

  input.consume()
}

function render(alpha, stats) {
  const now = performance.now()
  const theme = activeRoom?.arena || loadedAssets.arena || {}
  const renderState = netWorld.getRenderState(now, alpha)

  drawMultiplayerArena(ctx, size.w, size.h, {
    theme,
    stars: arenaStars,
    renderState,
    spriteSheet: loadedAssets.sprites.sheet || null,
  })

  hud.draw(ctx, stats, {
    playerName: activePlayerName,
    roomName: activeRoom?.name || 'Arena',
    muted: audio.isMuted(),
  })

  netPanel.update(now)
}

// 30 Hz клієнтська симуляція 1-в-1 з авторитетним сервером + 60/120/144 Hz інтерпольований рендер
const loop = createLoop({
  step: TICK_DT,
  simulate,
  render,
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
  netWorld.reset()
  roomPanel.show(activeRoom?.name)
  netPanel.show()
  if (activeRoom) {
    connection.connect({
      room: activeRoom.id,
      name: activePlayerName,
      codec: connection.codecName,
    })
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
  netWorld.reset()
  roomPanel.hide()
  netPanel.hide()
  loop.stop()
  input.clear()
  setLoadingControls('')
  mode = 'lobby'
  drawBackground(ctx, size.w, size.h)
  drawGrid(ctx, size.w, size.h)
  drawStarfield(ctx, bgStars)
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
  pointerFirePending = true
})

window.addEventListener('keydown', (e) => {
  if (isEditableTarget(e.target)) return
  if (mode !== 'playing' || e.repeat) return

  if (e.code === 'KeyM') {
    audio.toggleMute()
  } else if (e.code === 'Escape') {
    returnToLobby()
  }
})
