const GAME_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyR',
  'Space',
])

/**
 * Замикання над станом клавіатури: `down` і `pressed` повністю приватні.
 *
 * - `isDown(code)` — клавіша зараз затиснута (газ, поворот).
 * - `justPressed(code)` — клавіша натиснута після останнього `consume()`
 *   (разові дії: ресет, а з Lab 2 — постріл).
 * - `e.repeat` ігнорується, щоб автоповтор ОС не генерував хибні натискання.
 * - Системні модифікатори пропускаються, щоб працювали Ctrl+R, DevTools тощо.
 */
export function createInput(target) {
  const down = new Set()
  const pressed = new Set()

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (GAME_KEYS.has(e.code)) e.preventDefault()
    if (e.repeat) return
    if (!down.has(e.code)) pressed.add(e.code)
    down.add(e.code)
  }

  function onKeyUp(e) {
    if (GAME_KEYS.has(e.code)) e.preventDefault()
    down.delete(e.code)
    pressed.delete(e.code)
  }

  function onBlur() {
    down.clear()
    pressed.clear()
  }

  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)
  target.addEventListener('blur', onBlur)

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    consume() {
      pressed.clear()
    },
    destroy() {
      target.removeEventListener('keydown', onKeyDown)
      target.removeEventListener('keyup', onKeyUp)
      target.removeEventListener('blur', onBlur)
      down.clear()
      pressed.clear()
    },
  }
}

/**
 * Перетворює стан клавіатури браузера в чисту команду симуляції
 * { turn: -1 | 0 | 1, thrust: boolean }.
 */
export function readShipCommand(input, out = { turn: 0, thrust: false }) {
  const left = input.isDown('ArrowLeft') || input.isDown('KeyA')
  const right = input.isDown('ArrowRight') || input.isDown('KeyD')
  const thrust = input.isDown('ArrowUp') || input.isDown('KeyW')

  out.turn = (right ? 1 : 0) - (left ? 1 : 0)
  out.thrust = thrust
  return out
}
