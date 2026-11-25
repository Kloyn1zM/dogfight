import path from 'node:path'
import { z } from 'zod'

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3107',
  'http://127.0.0.1:3107',
].join(',')

const LogLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
])

export type LogLevel = z.infer<typeof LogLevelSchema>

function parseOriginList(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, '').toLowerCase())
    .filter((item) => item.length > 0)
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  LOG_DIR: z.string().min(1).default('logs'),
  LOG_LEVEL: LogLevelSchema.default('info'),
  GIT_SHA: z.string().min(1).default('dev'),
  ALLOWED_ORIGINS: z
    .string()
    .default(DEFAULT_ALLOWED_ORIGINS)
    .transform(parseOriginList)
    .refine(
      (list) => list.length > 0,
      'ALLOWED_ORIGINS must contain at least one origin',
    ),
  MAX_ROOMS: z.coerce.number().int().min(1).max(500).default(20),
  MAX_PLAYERS_PER_ROOM: z.coerce.number().int().min(1).max(64).default(16),
  MAX_TOTAL_PLAYERS: z.coerce.number().int().min(1).max(2000).default(128),
  MAX_CONNECTIONS_PER_IP: z.coerce.number().int().min(1).max(1000).default(20),
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
  SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(9500)
    .default(8000),
  TRUST_PROXY: z
    .string()
    .default('0')
    .transform((v) => v === '1'),
  ENABLE_SLOW_DEMO: z
    .string()
    .default('0')
    .transform((v) => v === '1'),
})

export interface ServerConfig {
  readonly port: number
  readonly host: string
  readonly logDir: string
  readonly logLevel: LogLevel
  readonly gitSha: string
  readonly allowedOrigins: readonly string[]
  readonly clientDistDir: string
  readonly maxRooms: number
  readonly maxPlayersPerRoom: number
  readonly maxTotalPlayers: number
  readonly maxConnectionsPerIp: number
  readonly maxPayloadBytes: number
  readonly rateLimitPerSec: number
  readonly slowClientThresholdBytes: number
  readonly joinTimeoutMs: number
  readonly heartbeatIntervalMs: number
  readonly shutdownTimeoutMs: number
  readonly trustProxy: boolean
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
    logLevel: v.LOG_LEVEL,
    gitSha: v.GIT_SHA,
    allowedOrigins: Object.freeze([...v.ALLOWED_ORIGINS]),
    clientDistDir: path.resolve(serverRoot, '../client/dist'),
    maxRooms: v.MAX_ROOMS,
    maxPlayersPerRoom: v.MAX_PLAYERS_PER_ROOM,
    maxTotalPlayers: v.MAX_TOTAL_PLAYERS,
    maxConnectionsPerIp: v.MAX_CONNECTIONS_PER_IP,
    maxPayloadBytes: v.MAX_PAYLOAD_BYTES,
    rateLimitPerSec: v.RATE_LIMIT_PER_SEC,
    slowClientThresholdBytes: v.SLOW_CLIENT_THRESHOLD_BYTES,
    joinTimeoutMs: v.JOIN_TIMEOUT_MS,
    heartbeatIntervalMs: v.HEARTBEAT_INTERVAL_MS,
    shutdownTimeoutMs: v.SHUTDOWN_TIMEOUT_MS,
    trustProxy: v.TRUST_PROXY,
    enableSlowDemo: v.ENABLE_SLOW_DEMO,
  })
}
