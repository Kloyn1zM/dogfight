import type { RosterEntry } from '@dogfight/shared'
import type { GameConnection } from '../net/connection.ts'
import { requireEl } from '../dom.ts'

export interface RoomPanelHandle {
  show(roomName?: string): void
  hide(): void
  destroy(): void
}

export function mountRoomPanel(
  container: HTMLElement,
  connection: GameConnection,
  { onLeave }: { onLeave?: () => void } = {},
): RoomPanelHandle {
  let myPlayerId: string | null = null
  let collapsed = false

  container.innerHTML = `
    <div class="rp-header">
      <strong id="rp-room-name">Кімната</strong>
      <div class="rp-actions">
        <span id="rp-status" class="rp-status">OFFLINE</span>
        <button id="rp-toggle" class="rp-btn" type="button" title="Згорнути/розгорнути чат">−</button>
        <button id="rp-leave" class="rp-btn rp-btn-leave" type="button" title="Повернутися в лобі">Лобі</button>
      </div>
    </div>
    <div class="rp-body">
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
    </div>
  `

  const roomNameEl = requireEl(container, '#rp-room-name', HTMLElement)
  const statusEl = requireEl(container, '#rp-status', HTMLElement)
  const toggleBtn = requireEl(container, '#rp-toggle', HTMLButtonElement)
  const leaveBtn = requireEl(container, '#rp-leave', HTMLButtonElement)
  const countEl = requireEl(container, '#rp-count', HTMLElement)
  const rosterEl = requireEl(container, '#rp-roster', HTMLUListElement)
  const messagesEl = requireEl(container, '#rp-messages', HTMLElement)
  const chatForm = requireEl(container, '#rp-chat-form', HTMLFormElement)
  const chatInput = requireEl(container, '#rp-chat-input', HTMLInputElement)

  function setCollapsed(next: boolean): void {
    collapsed = next
    container.classList.toggle('collapsed', collapsed)
    toggleBtn.textContent = collapsed ? '+' : '−'
  }

  toggleBtn.addEventListener('click', () => {
    setCollapsed(!collapsed)
    toggleBtn.blur()
  })

  leaveBtn.addEventListener('click', () => {
    leaveBtn.blur()
    onLeave?.()
  })

  function appendLine({
    author = '',
    text,
    kind = 'chat',
    t = Date.now(),
  }: {
    author?: string
    text: string
    kind?: 'chat' | 'system' | 'error'
    t?: number
  }): void {
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
    while (messagesEl.children.length > 60 && messagesEl.firstChild) {
      messagesEl.firstChild.remove()
    }
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function renderRoster(players: readonly RosterEntry[]): void {
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

  const offs = [
    connection.events.on('status', ({ status, attempt }) => {
      statusEl.dataset.state = status
      if (status === 'open') statusEl.textContent = 'ONLINE'
      else if (status === 'connecting') statusEl.textContent = 'CONNECTING'
      else if (status === 'reconnecting') {
        statusEl.textContent = `RECONNECT #${attempt ?? 1}`
      } else statusEl.textContent = 'OFFLINE'
    }),
    connection.events.on('welcome', (msg) => {
      myPlayerId = msg.playerId
      roomNameEl.textContent = msg.room.name
    }),
    connection.events.on('roster', (msg) => {
      renderRoster(msg.players)
    }),
    connection.events.on('chat', (msg) => {
      appendLine({
        author: msg.name,
        text: msg.text,
        kind: 'chat',
        t: msg.t,
      })
    }),
    connection.events.on('system', (msg) => {
      appendLine({ text: msg.text, kind: 'system', t: msg.t })
    }),
    connection.events.on('error', (msg) => {
      appendLine({
        text: `Помилка сервера: ${msg.reason}`,
        kind: 'error',
      })
    }),
  ]

  return {
    show(roomName?: string) {
      roomNameEl.textContent = roomName ?? 'Кімната'
      messagesEl.innerHTML = ''
      rosterEl.innerHTML = ''
      countEl.textContent = '0'
      const compactScreen =
        window.innerWidth < 900 || window.innerHeight < 520
      setCollapsed(compactScreen)
      container.classList.remove('hidden')
    },
    hide() {
      chatInput.blur()
      container.classList.add('hidden')
    },
    destroy() {
      for (const off of offs) off()
      container.innerHTML = ''
    },
  }
}
