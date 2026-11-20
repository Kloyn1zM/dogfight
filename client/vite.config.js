import { defineConfig } from 'vite'

function devLabMiddleware() {
  return {
    name: 'dogfight-lab3-dev-middleware',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next()
        const url = new URL(req.url, 'http://localhost')

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

        if (url.pathname === '/api/dev-corrupt.json') {
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end('{ "broken": true, ')
          return
        }

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
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:3000',
        ws: true,
      },
    },
  },
})