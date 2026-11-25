import { loadConfig } from './config.ts'
import { createServerApp } from './app.ts'

const config = loadConfig()
const app = createServerApp(config)

await app.listen()

let exiting = false

async function handleSignal(signal: NodeJS.Signals): Promise<void> {
  if (exiting) return
  exiting = true

  app.logger.info({ signal }, 'received termination signal')

  const forceTimer = setTimeout(() => {
    app.logger.fatal(
      { timeoutMs: config.shutdownTimeoutMs },
      'graceful shutdown timed out, forcing exit',
    )
    process.exit(1)
  }, config.shutdownTimeoutMs)
  forceTimer.unref()

  try {
    await app.shutdown(`Server shutting down (${signal})`)
    process.exit(0)
  } catch (err: unknown) {
    app.logger.fatal(
      { err: err instanceof Error ? err.message : String(err) },
      'error during graceful shutdown',
    )
    process.exit(1)
  }
}

process.on('SIGINT', () => void handleSignal('SIGINT'))
process.on('SIGTERM', () => void handleSignal('SIGTERM'))

process.on('uncaughtException', (err) => {
  app.logger.fatal({ err: err.message, stack: err.stack }, 'uncaughtException')
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  const stack = reason instanceof Error ? reason.stack : undefined
  app.logger.fatal({ err: message, stack }, 'unhandledRejection')
  process.exit(1)
})
