import { expect, test } from '@playwright/test'

interface DebugShipSnapshot {
  readonly id: number
  readonly name: string
  readonly isLocal: boolean
  readonly x: number
  readonly y: number
  readonly angle: number
}

interface DogfightWindow extends Window {
  __dogfight?: {
    getShips(): readonly DebugShipSnapshot[]
  }
}

test('two browsers in the same room see each other move and receive chat messages', async ({
  browser,
}) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const pageA = await ctxA.newPage()
  const pageB = await ctxB.newPage()

  try {
    await Promise.all([pageA.goto('/'), pageB.goto('/')])

    await expect(pageA.locator('#btn-join')).toBeEnabled()
    await expect(pageB.locator('#btn-join')).toBeEnabled()

    await pageA.locator('#pilot-name').fill('AlphaOne')
    await pageA.locator('#btn-join').click()

    await pageB.locator('#pilot-name').fill('BetaTwo')
    await pageB.locator('#btn-join').click()

    await expect(pageA.locator('#rp-status')).toHaveText('ONLINE')
    await expect(pageB.locator('#rp-status')).toHaveText('ONLINE')
    await expect(pageA.locator('#rp-count')).toHaveText('2')
    await expect(pageB.locator('#rp-count')).toHaveText('2')
    await expect(pageB.locator('#rp-roster')).toContainText('AlphaOne')
    await expect(pageB.locator('#rp-roster')).toContainText('BetaTwo')

    const readAlphaOnB = async (): Promise<DebugShipSnapshot | undefined> =>
      pageB.evaluate(() => {
        const w: DogfightWindow = window
        const ships = w.__dogfight?.getShips() ?? []
        return ships.find((s) => s.name === 'AlphaOne')
      })

    await expect
      .poll(async () => (await readAlphaOnB()) !== undefined, {
        timeout: 10_000,
      })
      .toBe(true)

    const initialAlpha = await readAlphaOnB()
    expect(initialAlpha).toBeDefined()
    if (!initialAlpha) return

    await pageA.locator('#game').click({ position: { x: 100, y: 100 } })
    await pageA.keyboard.down('KeyW')
    await pageA.keyboard.down('KeyD')
    await pageA.waitForTimeout(750)
    await pageA.keyboard.up('KeyW')
    await pageA.keyboard.up('KeyD')

    await expect
      .poll(
        async () => {
          const cur = await readAlphaOnB()
          if (!cur) return 0
          return Math.hypot(cur.x - initialAlpha.x, cur.y - initialAlpha.y)
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(20)

    const chatText = 'Привіт від AlphaOne!'
    await pageA.locator('#rp-chat-input').fill(chatText)
    await pageA.locator('#rp-chat-form button[type="submit"]').click()

    await expect(pageB.locator('#rp-messages')).toContainText('AlphaOne:')
    await expect(pageB.locator('#rp-messages')).toContainText(chatText)
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})
