import type { LocalCommand } from '../input.ts'

export interface TouchControlsHandle {
  show(): void
  hide(): void
  applyToCommand(command: LocalCommand): void
  destroy(): void
}

function isTouchDevice(): boolean {
  return (
    window.matchMedia('(pointer: coarse)').matches ||
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0
  )
}

export function mountTouchControls(
  container: HTMLElement,
): TouchControlsHandle {
  const state = {
    left: false,
    right: false,
    thrust: false,
    fire: false,
    fireHomingQueued: false,
  }

  container.innerHTML = `
    <div class="tc-group tc-left">
      <button type="button" class="tc-btn" data-act="left" aria-label="Поворот ліворуч">◀</button>
      <button type="button" class="tc-btn tc-thrust" data-act="thrust" aria-label="Тяга">▲</button>
      <button type="button" class="tc-btn" data-act="right" aria-label="Поворот праворуч">▶</button>
    </div>
    <div class="tc-group tc-right">
      <button type="button" class="tc-btn tc-homing" data-act="homing" aria-label="Ракета">E</button>
      <button type="button" class="tc-btn tc-fire" data-act="fire" aria-label="Постріл">FIRE</button>
    </div>
  `

  const activePointers = new Map<number, string>()

  function setAction(act: string, pressed: boolean): void {
    if (act === 'left') state.left = pressed
    else if (act === 'right') state.right = pressed
    else if (act === 'thrust') state.thrust = pressed
    else if (act === 'fire') state.fire = pressed
    else if (act === 'homing' && pressed) state.fireHomingQueued = true
  }

  function onPointerDown(e: PointerEvent): void {
    const target = e.target
    if (!(target instanceof HTMLElement)) return
    const btn = target.closest('[data-act]')
    if (!(btn instanceof HTMLElement)) return
    const act = btn.dataset.act
    if (!act) return
    e.preventDefault()
    btn.setPointerCapture?.(e.pointerId)
    activePointers.set(e.pointerId, act)
    btn.classList.add('active')
    setAction(act, true)
  }

  function releasePointer(e: PointerEvent): void {
    const act = activePointers.get(e.pointerId)
    if (!act) return
    activePointers.delete(e.pointerId)
    const btn = container.querySelector(`[data-act="${act}"]`)
    if (btn) btn.classList.remove('active')
    setAction(act, false)
  }

  container.addEventListener('pointerdown', onPointerDown)
  container.addEventListener('pointerup', releasePointer)
  container.addEventListener('pointercancel', releasePointer)

  return {
    show() {
      if (isTouchDevice()) {
        container.classList.remove('hidden')
      }
    },
    hide() {
      container.classList.add('hidden')
      state.left = false
      state.right = false
      state.thrust = false
      state.fire = false
      state.fireHomingQueued = false
      activePointers.clear()
    },
    applyToCommand(command: LocalCommand) {
      if (state.left && !state.right) command.turn = -1
      else if (state.right && !state.left) command.turn = 1
      if (state.thrust) command.thrust = true
      if (state.fire) command.fire = true
      if (state.fireHomingQueued) {
        command.fireHoming = true
        state.fireHomingQueued = false
      }
    },
    destroy() {
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('pointerup', releasePointer)
      container.removeEventListener('pointercancel', releasePointer)
      container.innerHTML = ''
    },
  }
}
