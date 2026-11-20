/**
 * UI-панель кімнати поверх гри: статус WebSocket, список гравців (roster) та чат.
 * Використовує лише textContent для повідомлень гравців (захист від XSS).
 */
export function mountRoomPanel(container, connection) {
  let myPlayerId = null

  container.innerHTML = `
    <div class="rp-header">
      <strong id="rp-room-name">Кімната</strong>
      <span id="rp-status" class="rp-status">OFFLINE</span>
    </div>
    <div class="rp-section-title">Гравці (<span id="rp-count">0</span>)</div>
    <ul id="rp-roster" class="rp-roster"></ul>
    <div class="rp-section-title">Чат кімнати</div>
    <div id="rp-messages" class="rp-messages"></div>
    <form id="rp-chat-form" class="rp-form">
      <input
        id="rp-chat-input"
        type="text"
        maxlength="200"
        autocomplete="off"
        placeholder="Написати в чат (Enter)..."
      />
      <button type="submit">Send</button>
    </form>
  `

  const roomNameEl = container.querySelector('#rp-room-name')
  const statusEl = container.querySelector('#rp-status')
  const countEl = container.querySelector('#rp-count')
  const rosterEl = container.querySelector('#rp-roster')
  const messagesEl = container.querySelector('#rp-messages')
  const chatForm = container.querySelector('#rp-chat-form')
  const chatInput = container.querySelector('#rp-chat-input')

  function appendLine({ author = '', text, kind = 'chat', t = Date.now() }) {
    const row = document.createElement('div')
    row.className = `rp-msg rp-msg-${kind}`

    const time = new Date(t).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })

    const timeSpan = document.createElement('span')
    timeSpan.className = 'rp-time'
    timeSpan.textContent = `[${time}] `
    row.appendChild(timeSpan)

    if (author) {
      const nameStrong = document.createElement('strong')
      nameStrong.textContent = `${author}: `
      row.appendChild(nameStrong)
    }

    const textSpan = document.createElement('span')
    textSpan.textContent = text
    row.appendChild(textSpan)

    messagesEl.appendChild(row)
    while (messagesEl.children.length > 60) {
      messagesEl.firstChild.remove()
    }
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function renderRoster(players) {
    rosterEl.innerHTML = ''
    countEl.textContent = String(players.length)
    for (const p of players) {
      const li = document.createElement('li')
      li.textContent = p.id === myPlayerId ? `${p.name} (ви)` : p.name
      if (p.id === myPlayerId) li.className = 'me'
      rosterEl.appendChild(li)
    }
  }

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const text = chatInput.value.trim()
    if (!text) return
    connection.sendChat(text)
    chatInput.value = ''
    chatInput.blur()
  })

  chatInput.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      e.stopPropagation()
      chatInput.blur()
    }
  })

  const onStatus = (e) => {
    const { status, attempt } = e.detail
    statusEl.dataset.state = status
    if (status === 'open') statusEl.textContent = 'ONLINE'
    else if (status === 'connecting') statusEl.textContent = 'CONNECTING'
    else if (status === 'reconnecting') {
      statusEl.textContent = `RECONNECT #${attempt}`
    } else statusEl.textContent = 'OFFLINE'
  }

  const onWelcome = (e) => {
    myPlayerId = e.detail.playerId
    roomNameEl.textContent = e.detail.room?.name || 'Кімната'
  }

  const onRoster = (e) => {
    renderRoster(e.detail.players || [])
  }

  const onChat = (e) => {
    appendLine({
      author: e.detail.name,
      text: e.detail.text,
      kind: 'chat',
      t: e.detail.t,
    })
  }

  const onSystem = (e) => {
    appendLine({ text: e.detail.text, kind: 'system', t: e.detail.t })
  }

  const onError = (e) => {
    appendLine({
      text: `Помилка сервера: ${e.detail.reason}`,
      kind: 'error',
    })
  }

  connection.addEventListener('status', onStatus)
  connection.addEventListener('welcome', onWelcome)
  connection.addEventListener('roster', onRoster)
  connection.addEventListener('chat', onChat)
  connection.addEventListener('system', onSystem)
  connection.addEventListener('error', onError)

  return {
    show(roomName) {
      roomNameEl.textContent = roomName || 'Кімната'
      messagesEl.innerHTML = ''
      rosterEl.innerHTML = ''
      countEl.textContent = '0'
      container.classList.remove('hidden')
    },
    hide() {
      chatInput.blur()
      container.classList.add('hidden')
    },
    destroy() {
      connection.removeEventListener('status', onStatus)
      connection.removeEventListener('welcome', onWelcome)
      connection.removeEventListener('roster', onRoster)
      connection.removeEventListener('chat', onChat)
      connection.removeEventListener('system', onSystem)
      connection.removeEventListener('error', onError)
      container.innerHTML = ''
    },
  }
}
