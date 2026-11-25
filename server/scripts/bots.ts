import { BotClient } from '../src/bot.ts'

function readArg(name: string, fallback: string): string {
  const prefix = `--${name}=`
  const found = process.argv.find((arg) => arg.startsWith(prefix))
  return found ? found.slice(prefix.length) : fallback
}

const count = Math.max(1, Math.min(64, Number(readArg('count', '8')) || 8))
const room = readArg('room', 'nebula-alpha')
const url = readArg('url', 'ws://127.0.0.1:3000/ws')
const durationSec = Math.max(0, Number(readArg('duration', '0')) || 0)

const bots: BotClient[] = []
for (let i = 1; i <= count; i += 1) {
  bots.push(
    new BotClient({
      url,
      room,
      name: `Bot-${String(i).padStart(2, '0')}`,
    }),
  )
}

console.log(`[Bots] Connecting ${count} bots to ${url} (room: ${room})...`)

const results = await Promise.allSettled(bots.map((b) => b.connect()))
const connected = results.filter((r) => r.status === 'fulfilled').length
for (const r of results) {
  if (r.status === 'rejected') {
    console.error('[Bots] join error:', r.reason)
  }
}

console.log(
  `[Bots] ${connected}/${count} bots active in "${room}". Press Ctrl+C to stop.`,
)

if (connected === 0) {
  process.exit(1)
}

const statusInterval = setInterval(() => {
  const totalInputs = bots.reduce((acc, b) => acc + b.getStats().inputsSent, 0)
  const totalSnaps = bots.reduce(
    (acc, b) => acc + b.getStats().snapshotsReceived,
    0,
  )
  const alive = bots.filter((b) => b.getStats().connected).length
  console.log(
    `[Bots] active=${alive}/${count} | inputsSent=${totalInputs} | snapshotsReceived=${totalSnaps}`,
  )
}, 5000)

function shutdown(): void {
  clearInterval(statusInterval)
  console.log('\n[Bots] Disconnecting all bots...')
  for (const b of bots) {
    b.disconnect()
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

if (durationSec > 0) {
  setTimeout(shutdown, durationSec * 1000)
}
