import { defineConfig } from 'vite'

function devLabMiddleware() {
  return {
    name: 'dogfight-lab3-dev-middleware',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next()
        const url = new URL(req.url, 'http://localhost')

        // Ендпоінт для тесту таймауту (відповідає пізніше, ніж AbortSignal.timeout)
        if (url.pathname === '/api/dev-timeout') {
          setTimeout(() => {
            if (!res.writableEnded) {
              res.statusCode = 200
              res.setHeader('Content-Type', 'application/json')
              res.end('{}')
            }
          }, 10000)
          return
        }

        // Ендпоінт для тесту битого JSON (200 OK, але невалідний синтаксис)
        if (url.pathname === '/api/dev-corrupt.json') {
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end('{ "broken": true, ')
          return
        }

        // Штучна затримка ?delay=350 для перевірки прогрес-бару та Promise.all vs seq
        const delayMs = Number(url.searchParams.get('delay') || 0)
        if (delayMs > 0) {
          setTimeout(() => next(), Math.min(delayMs, 3000))
          return
        }

        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [devLabMiddleware()],
})