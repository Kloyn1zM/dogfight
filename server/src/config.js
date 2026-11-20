import path from 'node:path'

function parsePositiveInt(
  env,
  key,
  fallback,
  { min = 1, max = Infinity } = {},
) {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const num = Number(raw)
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new Error(
      `Invalid env ${key}="${raw}" (expected integer in [${min}, ${max}])`,
    )
  }
  return num
}

export function loadConfig(env = process.env) {
  const serverRoot = path.resolve(import.meta.dirname, '..')
  const logDirRaw = env.LOG_DIR || 'logs'

  return Object.freeze({
    port: parsePositiveInt(env, 'PORT', 3000, { min: 1, max: 65535 }),
    host: env.HOST || '127.0.0.1',
    logDir: path.resolve(serverRoot, logDirRaw),
    clientDistDir: path.resolve(serverRoot, '../client/dist'),
    maxRooms: parsePositiveInt(env, 'MAX_ROOMS', 20, { min: 1, max: 500 }),
    maxPlayersPerRoom: parsePositiveInt(env, 'MAX_PLAYERS_PER_ROOM', 8, {
      min: 1,
      max: 64,
    }),
    maxPayloadBytes: parsePositiveInt(env, 'MAX_PAYLOAD_BYTES', 4096, {
      min: 256,
      max: 1024 * 1024,
    }),
    rateLimitPerSec: parsePositiveInt(env, 'RATE_LIMIT_PER_SEC', 20, {
      min: 1,
      max: 500,
    }),
    slowClientThresholdBytes: parsePositiveInt(
      env,
      'SLOW_CLIENT_THRESHOLD_BYTES',
      65536,
      { min: 1024, max: 16 * 1024 * 1024 },
    ),
    joinTimeoutMs: parsePositiveInt(env, 'JOIN_TIMEOUT_MS', 5000, {
      min: 500,
      max: 60000,
    }),
    heartbeatIntervalMs: parsePositiveInt(env, 'HEARTBEAT_INTERVAL_MS', 15000, {
      min: 1000,
      max: 120000,
    }),
    enableSlowDemo: env.ENABLE_SLOW_DEMO === '1',
  })
}
