import { ArenaConfigSchema, type ArenaConfig } from '@dogfight/shared'

export class HttpError extends Error {
  readonly url: string
  readonly status: number

  constructor(url: string, status: number, statusText: string) {
    super(`HTTP ${status} ${statusText} (${url})`)
    this.name = 'HttpError'
    this.url = url
    this.status = status
  }
}

export interface AssetManifest {
  readonly sprites: Readonly<Record<string, string>>
  readonly sounds: Readonly<Record<string, string>>
  readonly arena?: string
}

export interface LoadedAssets {
  readonly sprites: Record<string, HTMLImageElement>
  readonly sounds: Record<string, AudioBuffer>
  arena: ArenaConfig | null
  durationMs: number
}

export interface LoadProgress {
  readonly done: number
  readonly total: number
  readonly ratio: number
  readonly label: string
}

export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error || err instanceof DOMException)) return false
  return err.name === 'AbortError' || err.name === 'TimeoutError'
}

export function getErrorName(err: unknown): string {
  if (err instanceof Error || err instanceof DOMException) return err.name
  return 'Error'
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error || err instanceof DOMException) return err.message
  return String(err)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  return Object.values(value).every((v) => typeof v === 'string')
}

/** Type guard для валідації структури manifest.json на межі мережі. */
export function isAssetManifest(value: unknown): value is AssetManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  if (!('sprites' in value) || !isStringRecord(value.sprites)) return false
  if (!('sounds' in value) || !isStringRecord(value.sounds)) return false
  if (
    'arena' in value &&
    value.arena !== undefined &&
    typeof value.arena !== 'string'
  ) {
    return false
  }
  return true
}

function makeAbortError(signal?: AbortSignal): Error | DOMException {
  if (
    signal?.reason instanceof Error ||
    signal?.reason instanceof DOMException
  ) {
    return signal.reason
  }
  return new DOMException('Operation aborted', 'AbortError')
}

export function combineSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const active = signals.filter((s): s is AbortSignal => s !== undefined)
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  if ('any' in AbortSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(active)
  }

  const controller = new AbortController()
  for (const sig of active) {
    if (sig.aborted) {
      controller.abort(sig.reason)
      return controller.signal
    }
    sig.addEventListener('abort', () => controller.abort(sig.reason), {
      once: true,
    })
  }
  return controller.signal
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError(signal))
      return
    }
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(makeAbortError(signal))
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  {
    attempts = 3,
    baseMs = 200,
    signal,
  }: { attempts?: number; baseMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw makeAbortError(signal)
    try {
      return await fn(attempt)
    } catch (err: unknown) {
      const isClientError =
        err instanceof HttpError && err.status >= 400 && err.status < 500
      const isUserAbort = getErrorName(err) === 'AbortError'
      const isSyntax = err instanceof SyntaxError

      if (isClientError || isUserAbort || isSyntax || attempt === attempts) {
        throw err
      }

      const exp = baseMs * 2 ** (attempt - 1)
      const jitter = Math.random() * baseMs * 0.5
      await sleep(exp + jitter, signal)
    }
  }
  throw new Error('withRetry exhausted without result')
}

export async function fetchJson(
  url: string,
  {
    signal,
    timeoutMs = 5000,
  }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<unknown> {
  const combined = combineSignals(signal, AbortSignal.timeout(timeoutMs))
  const res = await fetch(url, { signal: combined })
  if (!res.ok) {
    throw new HttpError(url, res.status, res.statusText)
  }
  const data: unknown = await res.json()
  return data
}

export async function loadJson(
  url: string,
  {
    signal,
    timeoutMs = 5000,
    attempts = 3,
  }: { signal?: AbortSignal; timeoutMs?: number; attempts?: number } = {},
): Promise<unknown> {
  return withRetry(() => fetchJson(url, { signal, timeoutMs }), {
    attempts,
    signal,
  })
}

export async function loadImage(
  url: string,
  {
    signal,
    timeoutMs = 5000,
    attempts = 3,
  }: { signal?: AbortSignal; timeoutMs?: number; attempts?: number } = {},
): Promise<HTMLImageElement> {
  return withRetry(
    async () => {
      const combined = combineSignals(signal, AbortSignal.timeout(timeoutMs))
      const res = await fetch(url, { signal: combined })
      if (!res.ok) {
        throw new HttpError(url, res.status, res.statusText)
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)

      return new Promise<HTMLImageElement>((resolve, reject) => {
        if (combined?.aborted) {
          URL.revokeObjectURL(objectUrl)
          reject(makeAbortError(combined))
          return
        }

        const img = new Image()
        const cleanup = () => {
          img.onload = null
          img.onerror = null
          combined?.removeEventListener('abort', onAbort)
          URL.revokeObjectURL(objectUrl)
        }
        const onAbort = () => {
          cleanup()
          reject(makeAbortError(combined))
        }

        img.onload = () => {
          cleanup()
          resolve(img)
        }
        img.onerror = () => {
          cleanup()
          reject(new Error(`Failed to decode image: ${url}`))
        }

        combined?.addEventListener('abort', onAbort, { once: true })
        img.src = objectUrl
      })
    },
    { attempts, signal },
  )
}

export async function loadAudio(
  audioCtx: AudioContext,
  url: string,
  {
    signal,
    timeoutMs = 5000,
    attempts = 3,
  }: { signal?: AbortSignal; timeoutMs?: number; attempts?: number } = {},
): Promise<AudioBuffer> {
  return withRetry(
    async () => {
      const combined = combineSignals(signal, AbortSignal.timeout(timeoutMs))
      const res = await fetch(url, { signal: combined })
      if (!res.ok) {
        throw new HttpError(url, res.status, res.statusText)
      }
      const arrayBuffer = await res.arrayBuffer()
      if (combined?.aborted) throw makeAbortError(combined)
      return audioCtx.decodeAudioData(arrayBuffer)
    },
    { attempts, signal },
  )
}

function appendDelay(url: string, delayMs: number): string {
  if (!delayMs) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}delay=${delayMs}`
}

export async function loadAll(
  manifest: AssetManifest,
  {
    audioCtx,
    onProgress,
    signal,
    timeoutMs = 5000,
    delayMs = 0,
    sequential = false,
  }: {
    audioCtx: AudioContext
    onProgress?: (progress: LoadProgress) => void
    signal?: AbortSignal
    timeoutMs?: number
    delayMs?: number
    sequential?: boolean
  },
): Promise<LoadedAssets> {
  const assets: LoadedAssets = {
    sprites: {},
    sounds: {},
    arena: null,
    durationMs: 0,
  }

  const tasks: Array<{ label: string; run: () => Promise<void> }> = []

  for (const [key, rawUrl] of Object.entries(manifest.sprites)) {
    const url = appendDelay(rawUrl, delayMs)
    tasks.push({
      label: `sprite:${key}`,
      run: async () => {
        assets.sprites[key] = await loadImage(url, { signal, timeoutMs })
      },
    })
  }

  for (const [key, rawUrl] of Object.entries(manifest.sounds)) {
    const url = appendDelay(rawUrl, delayMs)
    tasks.push({
      label: `sound:${key}`,
      run: async () => {
        assets.sounds[key] = await loadAudio(audioCtx, url, {
          signal,
          timeoutMs,
        })
      },
    })
  }

  if (manifest.arena) {
    const url = appendDelay(manifest.arena, delayMs)
    tasks.push({
      label: 'arena:config',
      run: async () => {
        const raw = await loadJson(url, { signal, timeoutMs })
        const parsed = ArenaConfigSchema.safeParse(raw)
        if (!parsed.success) {
          throw new Error('Invalid arena config JSON')
        }
        assets.arena = parsed.data
      },
    })
  }

  const total = tasks.length
  let done = 0
  onProgress?.({ done: 0, total, ratio: 0, label: 'Починаємо завантаження...' })

  const startedAt = performance.now()

  const runTask = async (task: {
    label: string
    run: () => Promise<void>
  }): Promise<void> => {
    await task.run()
    done += 1
    onProgress?.({
      done,
      total,
      ratio: total === 0 ? 1 : done / total,
      label: task.label,
    })
  }

  if (sequential) {
    for (const task of tasks) {
      await runTask(task)
    }
  } else {
    await Promise.all(tasks.map((task) => runTask(task)))
  }

  assets.durationMs = performance.now() - startedAt
  return assets
}
