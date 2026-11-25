import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

const localChromePath =
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const useLocalChrome =
  !process.env.CI &&
  process.platform === 'win32' &&
  existsSync(localChromePath)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3107',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(useLocalChrome ? { channel: 'chrome' } : {}),
      },
    },
  ],
  webServer: {
    command: 'node server/dist/index.js',
    url: 'http://127.0.0.1:3107/health',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      PORT: '3107',
      HOST: '127.0.0.1',
      LOG_DIR: 'logs-e2e',
      LOG_LEVEL: 'silent',
      MAX_PLAYERS_PER_ROOM: '16',
    },
  },
})
