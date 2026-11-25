const CACHE_NAME = 'dogfight-v1'
const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/assets/manifest.json',
  '/assets/sprites.svg',
  '/assets/arena-default.json',
  '/assets/shoot.wav',
  '/assets/hit.wav',
  '/assets/explosion.wav',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // Ніколи не кешуємо живі API, WebSocket або health/metrics ендпоїнти
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ws') ||
    url.pathname === '/health' ||
    url.pathname === '/ready' ||
    url.pathname === '/metrics'
  ) {
    return
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put(req, clone))
          return res
        })
        .catch(() => caches.match('/')),
    )
    return
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached
      return fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put(req, clone))
        }
        return res
      })
    }),
  )
})
