import path from 'node:path'
import { z } from 'zod'

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  LOG_DIR: z.string().min(1).default('logs'),
  MAX_ROOMS: z.coerce.number().int().min(1).max(500).default(20),
  MAX_PLAYERS_PER_ROOM: z.coerce.number().int().min(1).max(64).default(16),
  MAX_PAYLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(256)
    .max(1024 * 1024)
    .default(16384),
  RATE_LIMIT_PER_SEC: z.coerce.number().int().min(1).max(500).default(120),
  SLOW_CLIENT_THRESHOLD_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024)
    .default(65536),
  JOIN_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(5000),
  HEARTBEAT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120000)
    .default(15000),
  ENABLE_SLOW_DEMO: z
    .string()
    .default('0')
    .transform((v) => v === '1'),
})

export interface ServerConfig {
  readonly port: number
  readonly host: string
  readonly logDir: string
  readonly clientDistDir: string
  readonly maxRooms: number
  readonly maxPlayersPerRoom: number
  readonly maxPayloadBytes: number
  readonly rateLimitPerSec: number
  readonly slowClientThresholdBytes: number
  readonly joinTimeoutMs: number
  readonly heartbeatIntervalMs: number
  readonly enableSlowDemo: boolean
}

export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ServerConfig {
  // Порожні рядки в env трактуємо як відсутні, щоб працювали дефолти Zod
  const cleaned: Record<string, string> = {}
  for (const [key, val] of Object.entries(env)) {
    if (val !== undefined && val !== '') {
      cleaned[key] = val
    }
  }

  const parsed = EnvSchema.safeParse(cleaned)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'env'}: ${i.message}`)
      .join('; ')
    throw new Error(`Invalid server config: ${details}`)
  }

  const v = parsed.data
  const serverRoot = path.resolve(import.meta.dirname, '..')

  return Object.freeze({
    port: v.PORT,
    host: v.HOST,
    logDir: path.resolve(serverRoot, v.LOG_DIR),
    clientDistDir: path.resolve(serverRoot, '../client/dist'),
    maxRooms: v.MAX_ROOMS,
    maxPlayersPerRoom: v.MAX_PLAYERS_PER_ROOM,
    maxPayloadBytes: v.MAX_PAYLOAD_BYTES,
    rateLimitPerSec: v.RATE_LIMIT_PER_SEC,
    slowClientThresholdBytes: v.SLOW_CLIENT_THRESHOLD_BYTES,
    joinTimeoutMs: v.JOIN_TIMEOUT_MS,
    heartbeatIntervalMs: v.HEARTBEAT_INTERVAL_MS,
    enableSlowDemo: v.ENABLE_SLOW_DEMO,
  })
}
