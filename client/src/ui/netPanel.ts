import type { CodecMode } from '@dogfight/shared'
import type { GameConnection } from '../net/connection.ts'
import type { NetWorld } from '../net/netWorld.ts'
import { requireEl } from '../dom.ts'

export interface NetPanelHandle {
  show(): void
  hide(): void
  update(now: number): void
  destroy(): void
}

export function mountNetPanel(
  container: HTMLElement,
  { connection, netWorld }: { connection: GameConnection; netWorld: NetWorld },
): NetPanelHandle {
  container.innerHTML = `
    <div class="np-header">
      <strong>NETGRAPH</strong>
      <select id="np-codec" title="Протокол передачі">
        <option value="binary">Binary (DataView)</option>
        <option value="json">JSON</option>
      </select>
    </div>
    <canvas id="np-graph" width="276" height="58"></canvas>
    <div id="np-stats" class="np-stats"></div>
    <div class="np-toggles">
      <label><input id="np-pred" type="checkbox" checked /> Prediction</label>
      <label><input id="np-det" type="checkbox" /> Break det.</label>
    </div>
    <div class="np-sliders">
      <label>RTT <span id="np-rtt-val">0</span>ms
        <input id="np-rtt" type="range" min="0" max="300" step="10" value="0" />
      </label>
      <label>Jitter <span id="np-jit-val">0</span>ms
        <input id="np-jit" type="range" min="0" max="100" step="5" value="0" />
      </label>
      <label>Drop <span id="np-drop-val">0</span>%
        <input id="np-drop" type="range" min="0" max="15" step="1" value="0" />
      </label>
      <label>Interp <span id="np-interp-val">80</span>ms
        <input id="np-interp" type="range" min="0" max="200" step="10" value="80" />
      </label>
    </div>
    <div class="np-presets">
      <button id="np-preset-clean" type="button">0 ms</button>
      <button id="np-preset-100" type="button">100ms ±30 / 2%</button>
    </div>
  `

  const codecSelect = requireEl(container, '#np-codec', HTMLSelectElement)
  const graphCanvas = requireEl(container, '#np-graph', HTMLCanvasElement)
  const statsEl = requireEl(container, '#np-stats', HTMLElement)
  const predCheck = requireEl(container, '#np-pred', HTMLInputElement)
  const detCheck = requireEl(container, '#np-det', HTMLInputElement)
  const rttInput = requireEl(container, '#np-rtt', HTMLInputElement)
  const jitInput = requireEl(container, '#np-jit', HTMLInputElement)
  const dropInput = requireEl(container, '#np-drop', HTMLInputElement)
  const interpInput = requireEl(container, '#np-interp', HTMLInputElement)
  const rttVal = requireEl(container, '#np-rtt-val', HTMLElement)
  const jitVal = requireEl(container, '#np-jit-val', HTMLElement)
  const dropVal = requireEl(container, '#np-drop-val', HTMLElement)
  const interpVal = requireEl(container, '#np-interp-val', HTMLElement)
  const cleanBtn = requireEl(container, '#np-preset-clean', HTMLButtonElement)
  const preset100Btn = requireEl(container, '#np-preset-100', HTMLButtonElement)

  const rawGraphCtx = graphCanvas.getContext('2d')
  if (!rawGraphCtx) {
    throw new Error('Could not acquire Netgraph 2D context')
  }
  const graphCtx: CanvasRenderingContext2D = rawGraphCtx
  const statsTextNode = document.createTextNode('')
  statsEl.appendChild(statsTextNode)
  const corrHistory: number[] = []
  const rttHistory: number[] = []
  const MAX_SAMPLES = 90

  function pushNetConfig(): void {
    const rttMs = Number(rttInput.value)
    const jitterMs = Number(jitInput.value)
    const dropRate = Number(dropInput.value) / 100
    rttVal.textContent = String(rttMs)
    jitVal.textContent = String(jitterMs)
    dropVal.textContent = dropInput.value
    connection.setNetConfig({ rttMs, jitterMs, dropRate })
  }

  codecSelect.addEventListener('change', () => {
    const mode: CodecMode = codecSelect.value === 'json' ? 'json' : 'binary'
    connection.setCodec(mode)
    codecSelect.blur()
  })

  predCheck.addEventListener('change', () => {
    netWorld.predictionEnabled = predCheck.checked
    netWorld.resetCorrectionPeak()
    predCheck.blur()
  })

  detCheck.addEventListener('change', () => {
    netWorld.breakDeterminism = detCheck.checked
    netWorld.resetCorrectionPeak()
    detCheck.blur()
  })

  rttInput.addEventListener('input', pushNetConfig)
  jitInput.addEventListener('input', pushNetConfig)
  dropInput.addEventListener('input', pushNetConfig)
  interpInput.addEventListener('input', () => {
    const ms = Number(interpInput.value)
    interpVal.textContent = String(ms)
    netWorld.interpolationDelayMs = ms
  })

  cleanBtn.addEventListener('click', () => {
    rttInput.value = '0'
    jitInput.value = '0'
    dropInput.value = '0'
    pushNetConfig()
    cleanBtn.blur()
  })

  preset100Btn.addEventListener('click', () => {
    rttInput.value = '100'
    jitInput.value = '30'
    dropInput.value = '2'
    pushNetConfig()
    preset100Btn.blur()
  })

  const offNetCfg = connection.events.on('netcfg', (cfg) => {
    rttInput.value = String(Math.round(cfg.rttMs))
    jitInput.value = String(Math.round(cfg.jitterMs))
    dropInput.value = String(Math.round(cfg.dropRate * 100))
    rttVal.textContent = rttInput.value
    jitVal.textContent = jitInput.value
    dropVal.textContent = dropInput.value
  })

  let lastSampleAt = 0

  function update(now: number): void {
    if (now - lastSampleAt < 100) return
    lastSampleAt = now

    const netStats = connection.getNetStats()
    const worldStats = netWorld.getMetrics(now)

    corrHistory.push(worldStats.lastCorrectionPx)
    rttHistory.push(netStats.rttMs)
    if (corrHistory.length > MAX_SAMPLES) corrHistory.shift()
    if (rttHistory.length > MAX_SAMPLES) rttHistory.shift()

    statsTextNode.nodeValue =
      `RTT: ${netStats.rttMs.toFixed(1)} ms | Snap age: ${worldStats.snapshotAgeMs.toFixed(0)} ms\n` +
      `In: ${(netStats.bytesInPerSec / 1024).toFixed(1)} KB/s | Out: ${(netStats.bytesOutPerSec / 1024).toFixed(2)} KB/s\n` +
      `Pending: ${worldStats.pendingInputs} | Corr: ${worldStats.lastCorrectionPx.toFixed(2)} px (max ${worldStats.maxCorrectionPx.toFixed(1)})`

    const w = graphCanvas.width
    const h = graphCanvas.height
    graphCtx.fillStyle = '#090c14'
    graphCtx.fillRect(0, 0, w, h)

    graphCtx.strokeStyle = '#38bdf8'
    graphCtx.lineWidth = 1.5
    graphCtx.beginPath()
    rttHistory.forEach((val, idx) => {
      const x = (idx / (MAX_SAMPLES - 1)) * w
      const y = h - Math.min(1, val / 300) * (h - 6) - 3
      if (idx === 0) graphCtx.moveTo(x, y)
      else graphCtx.lineTo(x, y)
    })
    graphCtx.stroke()

    for (let i = 0; i < corrHistory.length; i += 1) {
      const c = corrHistory[i]
      if (c === undefined || c < 0.2) continue
      const x = (i / (MAX_SAMPLES - 1)) * w
      const bh = Math.min(h - 4, (c / 40) * (h - 4))
      graphCtx.fillStyle = c > 10 ? '#f43f5e' : '#fb923c'
      graphCtx.fillRect(x, h - bh, 2.5, bh)
    }
  }

  return {
    show() {
      corrHistory.length = 0
      rttHistory.length = 0
      container.classList.remove('hidden')
    },
    hide() {
      container.classList.add('hidden')
    },
    update,
    destroy() {
      offNetCfg()
      container.innerHTML = ''
    },
  }
}
