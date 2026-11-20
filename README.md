# dogfight

Мультиплеєрна 2D-гра в реальному часі (клієнт на Canvas 2D + сервер на Node.js).

---

## Lab 01 — The Event Loop Is the Game Loop

### Запуск локально

~~~bash
nvm use
npm install
npm run lint
npm run dev
~~~

### Архітектура та налаштування фізики
- **Ігровий цикл (`src/loop.js`):** фіксований крок симуляції `step = 1/60` с поверх `requestAnimationFrame` із клампом `maxDelta = 0.25` с (захист від «спіралі смерті» після фрізів або повернення з фонової вкладки). Рендер працює на частоті дисплея та інтерполює стан за `alpha = accumulator / step`.
- **Ввід (`src/input.js`):** замикання з приватними `Set` (`isDown`, `justPressed`, `consume`, `destroy`), ігноруванням `e.repeat` і системних шорткатів. Адаптер `readShipCommand` відділяє коди клавіш браузера від симуляції, формуючи чисту команду `{ turn: -1 | 0 | 1, thrust: boolean }`.
- **Симуляція (`src/sim/ship.js`, `src/sim/arena.js`):** чиста детермінована фізика без залежностей від DOM/Canvas та тороїдальний wrap-around арени з корекцією інтерполяції (`hideWrapForLerp`).
- **Параметри керованості (`src/sim/ship.js`):**
  - `ROTATE_SPEED = 3.6` рад/с — повний оберт ~1.75 с, зручно точно наводити ніс;
  - `THRUST = 520` px/с² — відчутний розгін без надмірної інерції;
  - `DRAG = 1.15` с⁻¹ — експоненційне гальмування `Math.exp(-DRAG * dt)`, стабільне при відпусканні газу;
  - `MAX_SPEED = 380` px/с — контрольована швидкість у межах екрана.
- **Рендер (`src/render/canvas.js`, `src/render/draw.js`):** DPR-aware canvas із ресайзом, інтерполяція кута по найкоротшій дузі (`lerpAngle`), полум’я тяги, сітка, зоряне поле та HUD.

---

### Експерименти M4

#### Експеримент 1: Синхронний `busy-wait` (100 мс кожен 60-й кадр у `render`)

**Заміри:**
- Звичайний `frame ms`: **`16.80 ms`**
- Піковий `frame ms`: **`100.00 ms`**
- `frames/s`: **`55`** (втрачено ~5 кадрів за секунду на дисплеї 60 Hz)
- `steps/s`: **`60`** (симуляція наздогнала пропущений час через акумулятор)

**Спостереження та пояснення (Event Loop):**
Раз на секунду картинка завмирає, а після відвисання корабель робить помітний ривок уперед. JavaScript у вкладці виконується в одному потоці за моделлю *run-to-completion*: поки синхронний `while (performance.now() < t + 100)` займає Call Stack, Event Loop не може ні виконати фазу рендеру (`rAF → style → layout → paint`), ні забрати наступну задачу з Task Queue (натискання клавіш, таймери). Жоден `Promise` чи `setTimeout` у цьому ж потоці не здатен перервати активну синхронну функцію — винести таке блокування можна лише в окремий потік (Web Worker).

---

#### Експеримент 2: `setInterval(frame, 16)` замість `requestAnimationFrame`

**Заміри:**
- Активна вкладка: `dt ms ≈ 17.00 ms` (дрейф таймера відносно VSync 16.67 ms)
- Фонова вкладка (5 с): `framesPerSecond: 1`, `frameTimeMs: 999.3 ms`, `stepsPerSecond: 15`, `workTimeMs: 0.6 ms`

**Пояснення:**
1. На відміну від `requestAnimationFrame`, який браузер повністю ставить на паузу в невидимій вкладці, `setInterval` продовжує спрацьовувати у фоні з тротлінгом ~1 раз/с (`~999.3 ms`). Завдяки клампу `maxDelta = 0.25 s` за один фоновий виклик виконувалося рівно `0.25 / (1/60) = 15` кроків (`stepsPerSecond: 15`), що захистило вкладку від зависання.
2. `16 ms ≠ 16.667 ms`, інтервал не прив’язаний до частоти оновлення монітора (60/120/144 Hz) і потрапляє в Task Queue, а не в рендер-крок перед `paint`, тому виникає джитер і пропуски кадрів.

---

#### Експеримент 3: Фіксований крок (`1/60` с) vs змінний крок (`simulate(dt)`) під 6× CPU throttling

**Методика:** старт із центру арени (`x = 491.0000`, курс строго вгору `-π/2`), автоматичне утримання тяги 5 секунд симуляції; порівняння координат `(x, y)` без обмежень і з `DevTools → Performance → CPU: 6x slowdown`.

| Режим CPU | Fixed timestep (`1/60` с) `(x, y)` | Variable timestep (`simulate(dt)`) `(x, y)` |
|---|---|---|
| **1× CPU (No throttling)** | `(491.0000, 255.9345)` | `(491.0000, 262.2426)` |
| **6× CPU slowdown** | `(491.0000, 255.9345)` | `(491.0000, 262.2806)` |

**Висновок:**
За фіксованого кроку `1/60` с результати при 1× і 6× CPU збіглися **з точністю до 4-го знака після коми** (`255.9345` vs `255.9345`). За змінного кроку `simulate(dt)` траєкторія залежить від реальної тривалості кадрів і розходиться як із фіксованою моделлю (~6.3 px), так і між 1× та 6× CPU (`262.2426` vs `262.2806`). Детермінізм фіксованого кроку є критичним для мультиплеєра та client-side prediction у Lab 5.

---

## Lab 02 — Objects, Prototypes, and `this`: The Entity Model

### Що реалізовано
- **`Vector2` (`src/sim/vector.js`):** чисті векторні операції (`add`, `sub`, `scale`, `length`, `normalize`, `rotate`, `dot`, `Vector2.fromAngle`) + in-place утиліти (`set`, `copy`, `addInPlace`).
- **Модель сутностей (`src/sim/entity.js`, `src/sim/ship.js`, `src/sim/entities.js`):** базовий `Entity` із приватним статичним лічильником `#nextId` та приватним `#id`; успадкування строго в **один рівень** (`Ship`, `Bullet`, `Asteroid`, `Pickup`, `Explosion` успадковують `Entity`). У `Ship` здоров’я `#hp`, щит і кулдауни захищені приватними полями.
- **Світ на базі `Map` (`src/sim/world.js`):** приватна колекція `#entities = new Map()`, ітератор `[Symbol.iterator]()`, генератор `*ofKind(kind)` без проміжних масивів і відкладене видалення `#sweep()` наприкінці кроку.
- **Колізії та геймплей (`src/sim/collision.js`, `src/sim/world.js`):** ізольована функція-генератор `detectCollisions(world)` (готова до заміни на spatial hash у Lab 7), пружні відскоки астероїдів, розкол великих астероїдів, вибухи з частинок, респаун через 2 с у безпечній точці та підрахунок очок у HUD.

### Баг із `this` у колбеках і як його виправлено
Під час підключення стрільби по кліку миші наївно передати метод напряму:

~~~js
// БАГ: функція відірвана від об'єкта — браузер викличе її з this === canvasEl
canvasEl.addEventListener('pointerdown', player.fire)
~~~

За правилами прив’язки `this` (пріоритет: `new` → `call`/`apply`/`bind` → `obj.m()` → default `undefined` у strict mode) у такому виклику `this` вказує на `<canvas>`, тому звернення до приватного поля `this.#fireCooldown` миттєво кидає `TypeError`.

**Обраний фікс (`src/main.js`):** стрілкова обгортка `() => { const p = world.getPlayer(); if (p) p.fire(world) }`.
- *Чому саме вона:* зберігає метод на `Ship.prototype` (не дублюється на кожен екземпляр) і коректно працює після респауну нового екземпляра `Ship`.
- *Альтернативи та їхні мінуси:*
  1. `player.fire.bind(player)` — створює нову функцію і прив’язує її назавжди до старого корабля (зламається після смерті й респауну, а ще ускладнює `removeEventListener`).
  2. Стрілкове поле класу `fire = () => { ... }` — не лежить на прототипі, а створює окреме замикання на кожному екземплярі (зайва пам’ять при великій кількості сутностей).

### Композиція замість глибокого успадкування (`src/sim/behaviors.js`)
У грі з’явилися дві механіки, які ламають класичну ієрархію класів:
1. **Самонаведення (`homing`)** потрібне одночасно і для ракети (`Bullet`, наводиться на астероїди), і для агресивного червоного астероїда (`Asteroid`, переслідує корабель).
2. **Бонус (`Pickup` — щит або скорострільність)** є стаціонарним об’єктом із колізією та ефектом, але не є ні кораблем, ні снарядом.

**Як би виглядала ієрархія через `extends`:**
Довелося б будувати дерево на кшталт `Entity → MovingEntity → Bullet → HomingBullet` і паралельно `Entity → MovingEntity → Asteroid → HomingAsteroid` — дублюючи код наведення у двох гілках (або вигадуючи множинне успадкування, якого в JS немає). Додавання будь-якої нової комбінації (наприклад, рухомий бонус або самонавідний щит) вибухово множило б кількість підкласів.

**Обране рішення (компоненти-поведінки в `entity.behaviors`):**
Кожна сутність тримає масив незалежних компонентів (`createHoming(...)`, `createPickupEffect(...)`), а `runBehaviors(entity, dt, world)` виконує їх під час `update`. Одна й та сама функція `createHoming` працює і для фіолетової ракети (`KeyE`), і для червоного астероїда-переслідувача, залишаючи ієрархію `extends` плоскою (максимум 1 рівень) і тривіальною для серіалізації в Lab 5.

---

## Lab 03 — Asynchronous JavaScript: Promises, `async`/`await`, and the Loading Screen

### Що реалізовано
- **Пайплайн завантаження (`src/assets/loader.js`):** `fetchJson` (перевіряє `response.ok` і кидає `HttpError`), `withRetry` (експоненційний backoff + jitter, без повторних спроб на `4xx`, `AbortError` та `SyntaxError`), `loadImage`, `loadAudio` (Web Audio `decodeAudioData`), `loadJson` — усі приймають `AbortSignal`. `loadAll` завантажує ресурси паралельно через `Promise.all` із підрахунком прогресу по кожному елементу.
- **Спрайти, Web Audio та розв’язка через `EventTarget` (`src/audio.js`, `src/render/hud.js`, `src/sim/world.js`):** сутності малюються зі спрайт-листа `public/assets/sprites.svg` через `drawImage` (із векторним fallback). `AudioContext` розблоковується кліком «Приєднатися». `World` лише емітить `CustomEvent` (`fired`, `hit`, `exploded`, `pickup`, `score`) на `world.events` і має **нуль імпортів** аудіо чи HUD.
- **HTTP-лобі (`src/lobby/lobby.js`, `src/lobby/lobbyView.js`):** `Lobby extends EventTarget` періодично оновлює `/api/rooms.json` із `AbortSignal.timeout(4000)` та при виході викликає `abort()` для скасування активних запитів; DOM-рендер повністю винесений у `lobbyView.js`.

### Порівняння швидкості: послідовний `await` vs паралельний `Promise.all` (5 асетів)

| Режим завантаження | URL-параметри | Час завантаження | Пояснення |
|---|---|---|---|
| **Concurrent (`Promise.all`), без затримки** | за замовчуванням (`delay=0ms`) | **`45.6 ms`** | Локальне паралельне завантаження й декодування 5 асетів. |
| **Concurrent (`Promise.all`), `delay=250ms`** | `/?delay=250` | **`289.7 ms`** | Усі 5 запитів стартують одночасно; загальний час ≈ `250 ms` + декодування. |
| **Sequential (`for ... await`), `delay=250ms`** | `/?delay=250&seq=1` | **`1316.0 ms`** | Кожен наступний запит чекає завершення попереднього (`~5 × 250 ms`); у **4.54×** повільніше за `Promise.all`. |

### П’ять головоломок порядку виконання (Task / Microtask / `await` / `rAF`)

1. **Синхронний код, мікрозадача та `await`:**
   ~~~js
   async function f() {
     console.log('A')
     await null
     console.log('B')
   }
   Promise.resolve().then(() => console.log('C'))
   f()
   console.log('D')
   ~~~
   - **Вивід:** `A`, `D`, `C`, `B`.
   - **Пояснення:** `A` і `D` виконуються синхронно; `C` потрапив у чергу мікрозадач раніше, ніж `await null` поставив туди продовження `B`.

2. **`setTimeout` усередині `.then`:**
   ~~~js
   setTimeout(() => console.log('1'), 0)
   Promise.resolve()
     .then(() => {
       console.log('2')
       setTimeout(() => console.log('3'), 0)
     })
     .then(() => console.log('4'))
   console.log('5')
   ~~~
   - **Вивід:** `5`, `2`, `4`, `1`, `3`.
   - **Пояснення:** після синхронного `5` повністю спустошується мікрочерга (`2`, потім `4`), і лише після цього по черзі виконуються макрозадачі `1` і `3`.

3. **Забутий `return` у ланцюжку промісів:**
   ~~~js
   Promise.resolve(10)
     .then((n) => { Promise.resolve(n + 5) })
     .then((v) => console.log('val:', v))
   ~~~
   - **Вивід:** `val: undefined`.
   - **Пояснення:** перший `.then` нічого не повернув, тому наступний проміс у ланцюжку резолвиться з `undefined`.

4. **`requestAnimationFrame` vs мікрозадача всередині rAF:**
   ~~~js
   requestAnimationFrame(() => {
     console.log('raf-1')
     Promise.resolve().then(() => console.log('micro-in-raf'))
   })
   requestAnimationFrame(() => console.log('raf-2'))
   ~~~
   - **Вивід:** `raf-1`, `micro-in-raf`, `raf-2`.
   - **Пояснення:** мікрочерга очищується після завершення кожного колбеку, тому мікрозадача з першого `rAF` відпрацьовує раніше за другий `rAF`-колбек того ж кадру.

5. **Подія (`EventTarget`) синхронна, а проміс — завжди асинхронний:**
   ~~~js
   const bus = new EventTarget()
   bus.addEventListener('ping', () => console.log('event'))
   Promise.resolve().then(() => console.log('promise'))
   bus.dispatchEvent(new Event('ping'))
   console.log('sync')
   ~~~
   - **Вивід:** `event`, `sync`, `promise`.
   - **Пояснення:** `dispatchEvent` викликає слухачів синхронно на тому ж стеку, а `.then` завжди відкладається в чергу мікрозадач.

### Галерея помилок M4 (Graceful Recovery)

| Сценарій | Як відтворено | Фактичний вивід у консолі | Відновлення в UI |
|---|---|---|---|
| **Відсутній спрайт (404)** | `/?fail=404` (`/assets/does-not-exist-404.svg`) | `[Loader] failed: Error Failed to decode image: /assets/does-not-exist-404.svg` *(Vite SPA fallback повернув HTML замість SVG; для реального 404 `loadImage` кидає `HttpError 404` без ретраїв)* | Показ помилки на екрані завантаження + кнопки «Повторити» та «Грати без асетів (fallback)» із векторною графікою. |
| **Таймаут мережі** | `/?fail=timeout` (`/api/dev-timeout`, `1200 ms`) | `[Loader] failed: TimeoutError signal timed out` *(після 3 спроб з експоненційним backoff)* | Повідомлення про таймаут + кнопки «Повторити», fallback або «Назад у лобі». |
| **Битий JSON** | `/?fail=corrupt` (`/api/dev-corrupt.json`) | `[Loader] failed: SyntaxError Expected double-quoted property name in JSON at position 18 (line 1 column 19)` *(без ретраїв)* | Помилка перехоплена в `try/catch`, гра не зависає; доступні повтор, fallback і повернення в лобі. |
| **Скасування (Abort)** | `/?delay=1200` + клік «Скасувати (Abort)» | `[Loader] failed: AbortError Скасовано користувачем` *(негайне скасування без ретраїв)* | Активні `fetch` перериваються через `AbortController`; користувач може повторити або повернутися в лобі. |

---

## Lab 04 — Node.js: `EventEmitter`, Streams, and a WebSocket Server

### Що реалізовано
- **Workspaces (`package.json`, `client/`, `server/`):** монорепозиторій на базі npm workspaces із `"type": "module"`, префіксами `node:` для вбудованих модулів і конфігурацією з `.env` (`node --env-file=../.env`, валідація в `server/src/config.js`).
- **HTTP-сервер (`server/src/index.js`):** чистий `node:http` без фреймворків — роздає зібраний `client/dist/` із MIME-типами та захистом від path traversal (`..`), надає JSON API (`GET/POST /api/rooms`, `GET /api/replays`, `GET /api/replays/:id`, `GET /health`), Vite проксує `/api`, `/ws`, `/health` у dev-режимі; реалізовано graceful shutdown на `SIGINT`/`SIGTERM` (закриття сокетів із кодом `1001`, зупинка HTTP-сервера, дозапис логів, `exit 0`).
- **Кімнати та WebSocket (`server/src/rooms.js`, `server/src/ws.js`, `server/src/protocol.js`):** `Room extends EventEmitter`, `RoomManager` з автовидаленням порожніх непостійних кімнат, версіонований JSON-протокол `v1` із суворою валідацією кожного повідомлення, таймаут на `join` (5 с), heartbeat `ping`/`pong` кожні 15 с (розрив після 2 пропусків), обов’язкові `'error'`-слухачі на всіх сокетах та емітерах.
- **Захист від зловживань (`server/src/ws.js`):** `maxPayload` (4 KB), per-socket token-bucket rate limiter (`20 msg/s`), ліміти на кількість кімнат (`20`) і гравців у кімнаті (`8`), slow-client policy за `socket.bufferedAmount` (відкидання некритичних повідомлень вище 64 KB та закриття сокета при переповненні > 256 KB).
- **Клієнт (`client/src/net/connection.js`, `client/src/ui/roomPanel.js`):** `GameConnection` із диспетчеризацією по `type`, чергою відправки під час підключення та автоперепідключенням з експоненційним backoff + jitter; живий список гравців (`roster`) та чат у двох вікнах браузера.
- **Стрімові логи матчів (`server/src/log/matchlog.js`, `server/src/log/replay.js`):** object-mode `JsonLinesTransform` + `pipeline()` у `server/logs/<room>-<timestamp>.ndjson`; читання через async-генератор `readReplayEvents` і стрімова віддача `GET /api/replays/:id` через `pipeline(createReadStream, res)`.

---

### Експеримент M3 — Backpressure під час стрімінгу `200 MB` реплею

Згенеровано синтетичний лог `200.0 MB` і завантажено через `GET /api/replays/bench-200mb` штучно уповільненим клієнтом (`~25 MB/s`, загальний час `8.0 s`) із заміром пам’яті сервера через `/health` щосекунди:

| Час (с) | Server RSS (MB) | Heap Used (MB) | Графік RSS (масштаб: 1 блок ≈ 5 MB) |
|---:|---:|---:|---|
| 0 | 46.50 | 8.83 | `█████████` |
| 1 | 52.86 | 8.68 | `███████████` |
| 2 | 63.59 | 9.01 | `█████████████` |
| 3 | 52.42 | 7.47 | `██████████` |
| 4 | 57.87 | 7.70 | `████████████` |
| 5 | 65.88 | 8.02 | `█████████████` |
| 6 | 52.27 | 7.49 | `██████████` |
| 7 | 58.63 | 7.77 | `████████████` |
| 8 | 58.50 | 7.86 | `████████████` |

**Висновок (Backpressure):**
Незважаючи на те, що файл важить `200 MB`, а клієнт читає повільно, RSS сервера залишився **пласким у діапазоні `46.5–65.9 MB`** (heap `7.5–9.0 MB`). Коли внутрішній буфер сокета `res` перевищує `highWaterMark`, `res.write()` повертає `false`; `stream.pipeline()` автоматично ставить `createReadStream` на паузу і відновлює читання з диска лише після події `'drain'`. Без backpressure буфер у пам’яті ріс би до сотень мегабайтів аж до OOM.

---

### Нотатка M4 — Node Event Loop, блокування потоку та неперехоплені помилки

#### 1. Фази Node.js Event Loop і демонстрація блокування на 300 мс
Node.js виконує JavaScript-код в **одному потоці** поверх циклу **libuv**:
`timers (setTimeout)` → `pending callbacks` → `poll (I/O: мережа, файли)` → `check (setImmediate)` → `close callbacks`, причому після кожної фази повністю спорожнюються `process.nextTick` та черга мікрозадач Promise. Файловий I/O і DNS працюють у пулі потоків libuv, але обробники запитів і WebSocket-повідомлень виконуються на одному головному потоці.

**Демонстрація (`GET /api/slow?ms=300` паралельно з активним WebSocket-клієнтом):**

~~~text
{
  normalWsPingMs: 2.61,
  during300msBlockPingMs: 327.79,
  afterBlockPingMs: 0.61,
  serverBlockedMs: 300.4
}
~~~

Поки один HTTP-запит тримав головний потік у синхронному `while` протягом `300.4 ms`, цикл libuv не міг повернутися у фазу `poll`, тому затримка **зовсім іншого** підключеного WebSocket-клієнта зросла з `2.61 ms` до `327.79 ms`. Це означає, що жодна важка синхронна операція не може виконуватись у запитах ігрового сервера.

#### 2. Чому неперехоплений `'error'` (і unhandled rejection) валить увесь сервер
У Node.js `EventEmitter` має спеціальне правило: якщо викликати `emit('error', err)` без жодного підписаного слухача `'error'`, рушій кидає виняток на верхній рівень і **аварійно завершує весь процес** (так само як `unhandledRejection` у