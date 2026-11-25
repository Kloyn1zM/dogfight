import type { Difficulty, RoomPublicInfo } from '@dogfight/shared'
import { getErrorMessage } from '../assets/loader.ts'
import type { Lobby } from './lobby.ts'
import { requireEl } from '../dom.ts'

export interface LobbyViewHandle {
  show(): void
  hide(): void
  destroy(): void
}

function parseDifficulty(value: string): Difficulty {
  if (value === 'Hard') return 'Hard'
  if (value === 'Chill') return 'Chill'
  return 'Normal'
}

export function mountLobbyView(
  container: HTMLElement,
  lobby: Lobby,
): LobbyViewHandle {
  let selectedRoomId = ''

  container.innerHTML = `
    <div class="lobby-card">
      <div class="lobby-header">
        <h1>DOGFIGHT</h1>
        <span class="badge">Lab 07 · V8 &amp; Tests</span>
      </div>
      <label class="field">
        <span>Позивний пілота</span>
        <input id="pilot-name" type="text" maxlength="16" value="Ace-17" placeholder="Введи ім'я" />
      </label>
      <div class="rooms-bar">
        <span>Доступні кімнати</span>
        <button id="btn-refresh" type="button">Оновити</button>
      </div>
      <div id="lobby-status" class="status">Завантаження списку кімнат...</div>
      <ul id="room-list" class="room-list"></ul>
      <form id="create-room-form" class="create-room-row">
        <input id="new-room-name" type="text" maxlength="28" placeholder="Нова кімната..." />
        <select id="new-room-diff">
          <option value="Normal">Normal</option>
          <option value="Hard">Hard</option>
          <option value="Chill">Chill</option>
        </select>
        <button type="submit">+ Створити</button>
      </form>
      <button id="btn-join" class="btn-primary" type="button" disabled>Приєднатися та грати</button>
    </div>
  `

  const nameInput = requireEl(container, '#pilot-name', HTMLInputElement)
  const refreshBtn = requireEl(container, '#btn-refresh', HTMLButtonElement)
  const joinBtn = requireEl(container, '#btn-join', HTMLButtonElement)
  const statusEl = requireEl(container, '#lobby-status', HTMLElement)
  const listEl = requireEl(container, '#room-list', HTMLUListElement)
  const createForm = requireEl(container, '#create-room-form', HTMLFormElement)
  const newRoomInput = requireEl(container, '#new-room-name', HTMLInputElement)
  const newRoomDiff = requireEl(container, '#new-room-diff', HTMLSelectElement)

  function renderRooms(rooms: readonly RoomPublicInfo[]): void {
    listEl.innerHTML = ''
    const firstRoom = rooms[0]
    if (!firstRoom) {
      statusEl.textContent = 'Кімнат не знайдено.'
      joinBtn.disabled = true
      return
    }

    if (!rooms.some((r) => r.id === selectedRoomId)) {
      selectedRoomId = firstRoom.id
    }

    statusEl.textContent = `Оновлено о ${new Date().toLocaleTimeString()}`
    joinBtn.disabled = false

    for (const room of rooms) {
      const li = document.createElement('li')
      li.className = `room-item${room.id === selectedRoomId ? ' selected' : ''}`

      const left = document.createElement('div')
      const title = document.createElement('strong')
      title.textContent = room.name
      const meta = document.createElement('small')
      meta.textContent = `${room.difficulty} · астероїдів: ${room.arena.targetAsteroids}`
      left.append(title, meta)

      const pill = document.createElement('span')
      pill.className = 'pill'
      pill.textContent = `${room.players}/${room.maxPlayers}`

      li.append(left, pill)
      li.addEventListener('click', () => {
        selectedRoomId = room.id
        renderRooms(rooms)
      })
      listEl.appendChild(li)
    }
  }

  refreshBtn.addEventListener('click', () => {
    void lobby.refresh()
  })
  joinBtn.addEventListener('click', () => {
    lobby.join(selectedRoomId, nameInput.value)
  })

  createForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const name = newRoomInput.value.trim()
    if (!name) return
    try {
      const created = await lobby.createRoom(
        name,
        parseDifficulty(newRoomDiff.value),
      )
      if (created) {
        selectedRoomId = created.id
        newRoomInput.value = ''
        renderRooms(lobby.rooms)
      }
    } catch (err: unknown) {
      statusEl.textContent = `Не вдалося створити кімнату: ${getErrorMessage(err)}`
    }
  })

  const offs = [
    lobby.events.on('roomsChanged', ({ rooms }) => renderRooms(rooms)),
    lobby.events.on('error', ({ message }) => {
      statusEl.textContent = `Помилка завантаження кімнат: ${message}`
    }),
    lobby.events.on('loading', ({ loading }) => {
      refreshBtn.disabled = loading
    }),
    lobby.events.on('joined', () => {
      container.classList.add('hidden')
    }),
  ]

  return {
    show() {
      container.classList.remove('hidden')
    },
    hide() {
      container.classList.add('hidden')
    },
    destroy() {
      for (const off of offs) off()
      container.innerHTML = ''
    },
  }
}
