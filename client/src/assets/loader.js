export class HttpError extends Error {
  constructor(url, status, statusText) {
    super(`HTTP ${status} ${statusText} (${url})`)
    this.name = 'HttpError'
    this.url = url
    this.status = status
  }
}

export function isAbortError(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError'
}

function makeAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException('Operation aborted', 'AbortError')
}

export function combineSignals(...signals) {
  const active = signals.filter(Boolean)
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  if (typeof AbortSignal.any === 'function') {
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

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError(signal))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(makeAbortError(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Повтор спроб з експоненційним backoff + jitter.
 * НІКОЛИ не повторює 4xx (помилка клієнта / 404) і не повторює AbortError.
 */
export async function withRetry(
  fn,
  { attempts = 3, baseMs = 200, signal } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw makeAbortError(signal)
    try {
      return await fn(attempt)
    } catch (err) {
      const isClientError =
        err instanceof HttpError && err.status >= 400 && err.status < 500
      const isUserAbort = err?.name === 'AbortError'
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

/**
 * fetch не робить reject на HTTP 404/500 — перевіряємо response.ok вручну.
 */
export async function fetchJson(url, { signal, timeoutMs = 5000 } = {}) {
  const combined = combineSignals(signal, AbortSignal.timeout(timeoutMs))
  const res = await fetch(url, { signal: combined })
  if (!res.ok) {
    throw new HttpError(url, res.status, res.statusText)
  }
  return res.json()
}

export async function loadJson(
  url,
  { signal, timeoutMs = 5000, attempts = 3 } = {},
) {
  return withRetry(() => fetchJson(url, { signal, timeoutMs }), {
    attempts,
    signal,
  })
}

/**
 * Обгортка над callback-API Image з підтримкою AbortSignal.
 * Спочатку перевіряє HTTP-статус через fetch (щоб 404 одразу кидав HttpError 404
 * без зайвих ретраїв), а потім декодує картинку через Image.
 */
export async function loadImage(
  url,
  { signal, timeoutMs = 5000, attempts = 3 } = {},
) {
  return withRetry(
    async () => {
      const combined = combineSignals(signal, AbortSignal.timeout(timeoutMs))
      const res = await fetch(url, { signal: combined })
      if (!res.ok) {
        throw new HttpError(url, res.status, res.statusText)
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)

      return new Promise((resolve, reject) => {
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
  audioCtx,
  url,
  { signal, timeoutMs = 5000, attempts = 3 } = {},
) {
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

function appendDelay(url, delayMs) {
  if (!delayMs) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}delay=${delayMs}`
}

/**
 * Завантажує всі асети з manifest паралельно через Promise.all
 * із підрахунком прогресу по кожному елементу.
 * Режим `sequential: true` використовується для заміру в README (Lab 3 M1).
 */
export async function loadAll(
  manifest,
  {
    audioCtx,
    onProgress,
    signal,
    timeoutMs = 5000,
    delayMs = 0,
    sequential = false,
  } = {},
) {
  const tasks = []

  for (const [key, rawUrl] of Object.entries(manifest.sprites || {})) {
    const url = appendDelay(rawUrl, delayMs)
    tasks.push({
      group: 'sprites',
      key,
      label: `sprite:${key}`,
      run: () => loadImage(url, { signal, timeoutMs }),
    })
  }

  for (const [key, rawUrl] of Object.entries(manifest.sounds || {})) {
    const url = appendDelay(rawUrl, delayMs)
    tasks.push({
      group: 'sounds',
      key,
      label: `sound:${key}`,
      run: () => loadAudio(audioCtx, url, { signal, timeoutMs }),
    })
  }

  if (manifest.arena) {
    const url = appendDelay(manifest.arena, delayMs)
    tasks.push({
      group: 'arena',
      key: 'config',
      label: 'arena:config',
      run: () => loadJson(url, { signal, timeoutMs }),
    })
  }

  const total = tasks.length
  let done = 0
  onProgress?.({ done: 0, total, ratio: 0, label: 'Починаємо завантаження...' })

  const startedAt = performance.now()
  const assets = {
    sprites: {},
    sounds: {},
    arena: null,
    durationMs: 0,
  }

  const runTask = async (task) => {
    const value = await task.run()
    done += 1
    onProgress?.({
      done,
      total,
      ratio: total === 0 ? 1 : done / total,
      label: task.label,
    })
    return { task, value }
  }

  let results
  if (sequential) {
    results = []
    for (const task of tasks) {
      results.push(await runTask(task))
    }
  } else {
    results = await Promise.all(tasks.map((task) => runTask(task)))
  }

  for (const { task, value } of results) {
    if (task.group === 'sprites') assets.sprites[task.key] = value
    else if (task.group === 'sounds') assets.sounds[task.key] = value
    else if (task.group === 'arena') assets.arena = value
  }

  assets.durationMs = performance.now() - startedAt
  return assets
}
