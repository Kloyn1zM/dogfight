/**
 * Відображення лобі в DOM. Повністю відділене від мережевої логіки Lobby:
 * підписується на події EventTarget і викликає lobby.refresh() / lobby.join().
 */
export function mountLobbyView(container, lobby) {
  let selectedRoomId = ''

  container.innerHTML = `
    <div class="lobby-card">
      <div class="lobby-header">
        <h1>DOGFIGHT</h1>
        <span class="badge">Lab 03 · HTTP Lobby</span>
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
      <button id="btn-join" class="btn-primary" type="button" disabled>Приєднатися та грати</button>
    </div>
  `

  const nameInput = container.querySelector('#pilot-name')
  const refreshBtn = container.querySelector('#btn-refresh')
  const joinBtn = container.querySelector('#btn-join')
  const statusEl = container.querySelector('#lobby-status')
  const listEl = container.querySelector('#room-list')

  function renderRooms(rooms) {
    listEl.innerHTML = ''
    if (rooms.length === 0) {
      statusEl.textContent = 'Кімнат не знайдено.'
      joinBtn.disabled = true
      return
    }

    if (!rooms.some((r) => r.id === selectedRoomId)) {
      selectedRoomId = rooms[0].id
    }

    statusEl.textContent = `Оновлено о ${new Date().toLocaleTimeString()}`
    joinBtn.disabled = false

    for (const room of rooms) {
      const li = document.createElement('li')
      li.className = `room-item${room.id === selectedRoomId ? ' selected' : ''}`
      li.innerHTML = `
        <div>
          <strong>${room.name}</strong>
          <small>${room.difficulty} · астероїдів: ${room.arena.targetAsteroids}</small>
        </div>
        <span class="pill">${room.players}/${room.maxPlayers}</span>
      `
      li.addEventListener('click', () => {
        selectedRoomId = room.id
        renderRooms(rooms)
      })
      listEl.appendChild(li)
    }
  }

  refreshBtn.addEventListener('click', () => lobby.refresh())
  joinBtn.addEventListener('click', () => {
    lobby.join(selectedRoomId, nameInput.value)
  })

  const onRooms = (e) => renderRooms(e.detail.rooms)
  const onError = (e) => {
    statusEl.textContent = `Помилка завантаження кімнат: ${e.detail.message}`
  }
  const onLoading = (e) => {
    refreshBtn.disabled = e.detail.loading
  }
  const onJoined = () => {
    container.classList.add('hidden')
  }

  lobby.addEventListener('roomsChanged', onRooms)
  lobby.addEventListener('error', onError)
  lobby.addEventListener('loading', onLoading)
  lobby.addEventListener('joined', onJoined)

  return {
    show() {
      container.classList.remove('hidden')
    },
    hide() {
      container.classList.add('hidden')
    },
    destroy() {
      lobby.removeEventListener('roomsChanged', onRooms)
      lobby.removeEventListener('error', onError)
      lobby.removeEventListener('loading', onLoading)
      lobby.removeEventListener('joined', onJoined)
      container.innerHTML = ''
    },
  }
}
