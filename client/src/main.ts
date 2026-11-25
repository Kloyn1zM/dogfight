import './style.css'
import {
  TICK_DT,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  asEntityId,
  createShipState,
  hashShipState,
  integrateShip,
  type RoomPublicInfo,
} from '@dogfight/shared'
import { createLoop, type LoopStats } from './loop.ts'
import {
  createInput,
  isEditableTarget,
  readShipCommand,
  type LocalCommand,
} from './input.ts'
import { createCanvas } from './render/canvas.ts'
import {
  createStarfield,
  drawBackground,
  drawGrid,
  drawLoadingScreen,
  drawMultiplayerArena,
  drawStarfield,
  type LoadingScreenState,
  type Star,
} from './render/draw.ts'
import { createHud } from './render/hud.ts'
import { createAudioManager } from './audio.ts'
import {
  getErrorMessage,
  getErrorName,
  isAssetManifest,
  loadAll,
  loadJson,
  type AssetManifest,
  type LoadedAssets,
} from './assets/loader.ts'
import { Lobby } from './lobby/lobby.ts'
import { mountLobbyView } from './lobby/lobbyView.ts'
import { GameConnection } from './net/connection.ts'
import { NetWorld } from './net/netWorld.ts'
import { mountRoomPanel } from './ui/roomPanel.ts'
import { mountNetPanel } from './ui/netPanel.ts'
import { mountTouchControls } from './ui/touchControls.ts'
import { requireEl } from './dom.ts'
import { createFramePerfRecorder, type PerfReport } from './perf.ts'

interface DogfightDebugShip {
  readonly id: number
  readonly name: string
  readonly isLocal: boolean
  readonly x: number
  readonly y: number
  readonly angle: number
}

declare global {
  interface Window {
    __dogfight?: {
      getShips(): readonly DogfightDebugShip[]
      getPerfReport(): PerfReport | null
    }
  }
}

function logBrowserDeterminismHash(): void {
  const ship = createShipState({
    id: asEntityId(1),
    x: 640,
    y: 360,
    angle: -Math.PI / 2,
  })
  for (let i = 0; i < 1000; i += 1) {
    const turn = i % 30 < 10 ? 1 : i % 30 < 20 ? -1 : 0
    const thrust = i % 3 !== 0
    integrateShip(ship, { turn, thrust }, TICK_DT)
  }
  console.log('[Determinism] Browser 1000-step hash:', hashShipState(ship))
}
logBrowserDeterminismHash()

const canvasEl = requireEl(document, '#game', HTMLCanvasElement)
const lobbyOverlay = requireEl(document, '#lobby-overlay', HTMLElement)
const loadingControls = requireEl(document, '#loading-controls', HTMLElement)
const roomPanelEl = requireEl(document, '#room-panel', HTMLElement)
const netPanelEl = requireEl(document, '#net-panel', HTMLElement)
const touchControlsEl = requireEl(document, '#touch-controls', HTMLElement)

const params = new URLSearchParams(window.location.search)
const devDelayMs = Number(params.get('delay') ?? 0)
const devSequential = params.get('seq') === '1'
const devFailMode = params.get('fail') ?? ''
const devPerfSec = Number(params.get('perf') ?? 0)

const perfRecorder = createFramePerfRecorder(devPerfSec, (report) => {
  console.log('[Perf] Frame report:', JSON.stringify(report))
})

const input = createInput(window)
const netWorld = new NetWorld()
window.__dogfight = {
  getShips() {
    const rs = netWorld.getRenderState(performance.now(), 1)
    const ships: DogfightDebugShip[] = []
    for (const e of rs.entities) {
      if (e.kind === 'ship') {
        ships.push({
          id: e.id,
          name: e.name,
          isLocal: e.isLocal,
          x: e.x,
          y: e.y,
          angle: e.angle,
        })
      }
    }
    return ships
  },
  getPerfReport() {
    return perfRecorder.getReport()
  },
}
const hud = createHud(netWorld)
const audio = createAudioManager()
audio.attachBus(netWorld.events)

const connection = new GameConnection()
const roomPanel = mountRoomPanel(roomPanelEl, connection)
const netPanel = mountNetPanel(netPanelEl, { connection, netWorld })
const touchControls = mountTouchControls(touchControlsEl)

const command: LocalCommand = {
  turn: 0,
  thrust: false,
  fire: false,
  fireHoming: false,
}
const arenaStars = createStarfield(WORLD_WIDTH, WORLD_HEIGHT, 160)

type AppMode = 'lobby' | 'loading' | 'playing'

let bgStars: Star[] = []
let mode: AppMode = 'lobby'
let activeRoom: RoomPublicInfo | null = null
let activePlayerName = 'Pilot'
let loadedAssets: LoadedAssets = {
  sprites: {},
  sounds: {},
  arena: null,
  durationMs: 0,
}
let loadController: AbortController | null = null
let loadingState: LoadingScreenState = { ratio: 0, label: '', error: null }
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

connection.events.on('welcome', (msg) => {
  netWorld.setWelcome({ shipId: msg.shipId, tick: msg.tick })
})

connection.events.on('roster', (msg) => {
  netWorld.setRoster(msg.players)
})

connection.events.on('snapshot', ({ snapshot, receivedAt }) => {
  netWorld.onSnapshot(snapshot, receivedAt)
})

connection.events.on('binarySnapshot', ({ data, receivedAt }) => {
  try {
    netWorld.onBinarySnapshot(data, receivedAt)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[WS] failed to decode binary snapshot:', msg)
  }
})

connection.events.on('events', (msg) => {
  netWorld.onServerEvents(msg.events)
})

connection.events.on('fatalDisconnect', ({ reason }) => {
  if (mode === 'playing') {
    returnToLobby(reason)
  }
})

function simulate(dt: number): void {
  readShipCommand(input, command)
  touchControls.applyToCommand(command)
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

function render(alpha: number, stats: LoopStats): void {
  const now = performance.now()
  const theme = activeRoom?.arena ?? loadedAssets.arena ?? undefined
  const renderState = netWorld.getRenderState(now, alpha)

  drawMultiplayerArena(ctx, size.w, size.h, {
    theme,
    stars: arenaStars,
    renderState,
    spriteSheet: loadedAssets.sprites.sheet ?? null,
  })

  hud.draw(ctx, stats, {
    playerName: activePlayerName,
    roomName: activeRoom?.name ?? 'Arena',
    muted: audio.isMuted(),
    perfText: perfRecorder.getStatusText(now),
  })

  netPanel.update(now)
  perfRecorder.recordFrame(now, stats.frameTimeMs, stats.workTimeMs)
}

const loop = createLoop({
  step: TICK_DT,
  simulate,
  render,
})

function setLoadingControls(
  html: string,
  handlers: Record<string, () => void> = {},
): void {
  loadingControls.innerHTML = html
  loadingControls.classList.toggle('hidden', !html)
  for (const [selector, fn] of Object.entries(handlers)) {
    const el = loadingControls.querySelector(selector)
    if (el) el.addEventListener('click', fn)
  }
}

function startPlaying(assets: LoadedAssets): void {
  loadedAssets = assets
  audio.setBuffers(assets.sounds)
  setLoadingControls('')
  mode = 'playing'
  netWorld.reset()
  perfRecorder.reset()
  roomPanel.show(activeRoom?.name)
  netPanel.show()
  touchControls.show()
  if (activeRoom) {
    connection.connect({
      room: activeRoom.id,
      name: activePlayerName,
      codec: connection.codecName,
    })
  }
  loop.start()
}

async function beginLoadingAndPlay({
  ignoreDevFail = false,
}: { ignoreDevFail?: boolean } = {}): Promise<void> {
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
    const rawManifest = await loadJson('/assets/manifest.json', {
      signal: loadController.signal,
      timeoutMs: 4000,
    })
    if (!isAssetManifest(rawManifest)) {
      throw new Error('Invalid manifest.json structure')
    }

    const testSprites: Record<string, string> = { ...rawManifest.sprites }
    let testArena = rawManifest.arena
    let timeoutMs = 5000

    if (!ignoreDevFail && devFailMode === '404') {
      testSprites.sheet = '/assets/does-not-exist-404.svg'
    } else if (!ignoreDevFail && devFailMode === 'timeout') {
      testArena = '/api/dev-timeout'
      timeoutMs = 1200
    } else if (!ignoreDevFail && devFailMode === 'corrupt') {
      testArena = '/api/dev-corrupt.json'
    }

    const testManifest: AssetManifest = {
      sprites: testSprites,
      sounds: rawManifest.sounds,
      arena: testArena,
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
  } catch (err: unknown) {
    const name = getErrorName(err)
    const message = getErrorMessage(err)
    console.warn('[Loader] failed:', name, message)
    loadingState = {
      ratio: loadingState.ratio,
      label: '',
      error: `${name}: ${message}`,
    }
    drawLoadingScreen(ctx, size.w, size.h, loadingState)

    setLoadingControls(
      `
        <button id="btn-retry" type="button">Повторити (чистий маніфест)</button>
        <button id="btn-fallback" type="button">Грати без асетів (fallback)</button>
        <button id="btn-back" type="button">Назад у лобі</button>
      `,
      {
        '#btn-retry': () => void beginLoadingAndPlay({ ignoreDevFail: true }),
        '#btn-fallback': () =>
          startPlaying({
            sprites: {},
            sounds: {},
            arena: activeRoom?.arena ?? null,
            durationMs: 0,
          }),
        '#btn-back': () => returnToLobby(),
      },
    )
  }
}

const lobby = new Lobby({ endpoint: '/api/rooms' })
const lobbyView = mountLobbyView(lobbyOverlay, lobby)

function returnToLobby(notice?: string): void {
  loadController?.abort()
  connection.disconnect()
  netWorld.reset()
  roomPanel.hide()
  netPanel.hide()
  touchControls.hide()
  loop.stop()
  input.clear()
  setLoadingControls('')
  mode = 'lobby'
  drawBackground(ctx, size.w, size.h)
  drawGrid(ctx, size.w, size.h)
  drawStarfield(ctx, bgStars)
  lobbyView.show(notice)
  lobby.startPolling(5000)
}

lobby.events.on('joined', ({ room, playerName }) => {
  activeRoom = room
  activePlayerName = playerName
  void audio.unlock().then(() => beginLoadingAndPlay())
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

if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
      console.warn('[PWA] service worker registration failed:', err)
    })
  })
}
