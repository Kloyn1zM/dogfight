const GAME_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyE',
  'KeyP',
  'KeyR',
  'Space',
])

export function isEditableTarget(el) {
  if (!el || typeof el !== 'object') return false
  const tag = el.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    Boolean(el.isContentEditable)
  )
}

export function createInput(target) {
  const down = new Set()
  const pressed = new Set()

  function onKeyDown(e) {
    if (isEditableTarget(e.target)) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (GAME_KEYS.has(e.code)) e.preventDefault()
    if (e.repeat) return
    if (!down.has(e.code)) pressed.add(e.code)
    down.add(e.code)
  }

  function onKeyUp(e) {
    if (isEditableTarget(e.target)) {
      down.delete(e.code)
      pressed.delete(e.code)
      return
    }
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
    clear() {
      down.clear()
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

export function readShipCommand(
  input,
  out = { turn: 0, thrust: false, fire: false, fireHoming: false },
) {
  const left = input.isDown('ArrowLeft') || input.isDown('KeyA')
  const right = input.isDown('ArrowRight') || input.isDown('KeyD')
  const thrust = input.isDown('ArrowUp') || input.isDown('KeyW')

  out.turn = (right ? 1 : 0) - (left ? 1 : 0)
  out.thrust = thrust
  out.fire = input.isDown('Space')
  out.fireHoming = input.justPressed('KeyE')
  return out
}
