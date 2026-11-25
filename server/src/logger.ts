import pino, { type Logger } from 'pino'
import type { LogLevel } from './config.ts'

export type ServerLogger = Logger

export function createLogger(
  level: LogLevel = 'info',
  gitSha = 'dev',
): ServerLogger {
  return pino({
    level,
    base: {
      service: 'dogfight-server',
      gitSha,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'password',
        'token',
        'secret',
        'apiKey',
        'authorization',
        'cookie',
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.token',
        '*.secret',
      ],
      censor: '[REDACTED]',
    },
  })
}
