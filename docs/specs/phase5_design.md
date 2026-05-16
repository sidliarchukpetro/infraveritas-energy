# Phase 5 — Continuous Monitoring через The Graph

*Design doc, 2026-05-16*
*Architectural Phase 5 / 8-phase roadmap*

---

## 1. Призначення

Зараз для зовнішнього спостерігача (інвестор, аудитор, ECSP-партнер) шлях побачити "які submissions були за останні 30 днів" — **складний**. Дві опції:

1. Прямий запит до нашого Postgres — приватно, потребує credentials
2. Парсинг Ethereum events через RPC — складно, повільно, без агрегацій

Phase 5 додає **публічний шар** між blockchain і user-friendly інтерфейсом:

```
V3 emit-ить події → The Graph слухає → індексує у власну БД →
GraphQL API → публічний dashboard (HTML + запити)
```

Кінцевий результат — публічний URL де хто завгодно може побачити:
- Загальна кількість submissions
- Список пристроїв і їх статус
- Submission-и за обраний період
- "Post-disconnection" події (коли пристрій повернувся після перерви)
- Карта пристроїв (через lat/lon з DeviceRegistry)

**Це не замінює** наш Postgres hypertable — він залишається **internal observability** (з повним validation outcome, weather data, anomaly flags). Phase 5 — **public, on-chain only**.

---

## 2. Що таке The Graph (коротко)

The Graph — це безкоштовний сервіс для індексації blockchain-подій. Працює так:

1. Ти пишеш **subgraph** — невелику програму яка слухає певні події з певних контрактів
2. Підіймаєш subgraph у "The Graph Studio" (безкоштовний хостинг)
3. The Graph crawl-ить blockchain від обраного блоку, викликає твої обробники подій
4. Обробники складають дані у схему (як таблиці)
5. Користувачі/dashboards запитують ці дані через **GraphQL** — мова запитів подібна до SQL але для зв'язаних сутностей

**Перевага над прямим RPC:** один GraphQL запит замість 1000 RPC calls для отримання submission-ів за місяць.

---

## 3. Сутності у нашому subgraph

Підбираємо схему на основі того що V3 і DeviceRegistry емітять.

### Подія → дія таблиця

| Контракт | Подія | Що робимо |
|---|---|---|
| DeviceRegistry | `DeviceRegistered(pubKeyHash, latE7, lonE7, registeredAt, operator)` | Створюємо `Device` сутність зі статусом "active" |
| DeviceRegistry | `DeviceRevoked(pubKeyHash, operator)` | `Device.status = "revoked"` |
| DeviceRegistry | `DeviceReactivated(pubKeyHash, operator)` | `Device.status = "active"` |
| DeviceRegistry | `DeviceSuspended(pubKeyHash, operator)` | `Device.status = "suspended"` |
| V3 | `ProofSubmitted(deviceId, sessionKey, timestamp, gap, postDisconnection)` | Створюємо `Submission` + інкрементуємо лічильники |

### Сутності (схема)

**Device** — один пристрій:
```
id              = pubKeyHash (hex)
latE7, lonE7    = координати з реєстрації
registeredAt    = час реєстрації
status          = "active" / "revoked" / "suspended"
submissionCount = скільки proofs подав
postDisconnectionCount = скільки разів повертався після перерви
```

**Submission** — один proof:
```
id              = sessionKey (hex) — унікальний, замінний replay-protection key
device          = посилання на Device
timestamp       = з події
gapFromPrevious = з події (час від попереднього submission)
postDisconnection = boolean з події
txHash, blockNumber = метадані для Etherscan link
```

**DailyStat** — агрегат на пристрій за день:
```
id              = YYYY-MM-DD-pubKeyHash
date            = дата
device          = посилання
submissionCount = за цей день
postDisconnectionCount = за цей день
```

**Protocol** — глобальний агрегат (один запис):
```
id              = "0" (singleton)
totalDevices    = усього пристроїв зареєстровано
activeDevices   = скільки зараз active
totalSubmissions = всі proof submissions
```

---

## 4. Розбиття на під-етапи

| Етап | Що | Час | Складність |
|---|---|---|---|
| **5a** | Subgraph package — структура, схема, обробники V3 і DeviceRegistry. Локальний тест через graph-node | 2-3 год | Середня — нова технологія |
| **5b** | DailyStat обчислення + Protocol singleton + edge cases (повторні події, missing device) | 1-2 год | Низька |
| **5c** | Розгортання на The Graph Studio (безкоштовний хостинг). Перевірка GraphQL playground | 30 хв | Низька |
| **5d** | Простий публічний dashboard — HTML/JS статичний сайт + Netlify/GitHub Pages | 2-3 год | Низька-середня |

**Total: 6-9 годин** для повного Phase 5.

---

## 5. Dashboard — масштаб

Не Next.js / React додаток. **Простий статичний HTML+JS:**

- Один файл `index.html` + `app.js` + `style.css`
- GraphQL запити прямо з браузера (через `fetch`)
- Без бекенду — все клієнт-сайд
- Хост: GitHub Pages (на тому самому домені де infraveritas.pro може redirect)

**Сторінки/секції:**
1. **Огляд** — лічильники: device count, total submissions, today's submissions, last submission time
2. **Список пристроїв** — таблиця з: pubKeyHash (скорочений), status, реєстрація, submission count, кнопка "details"
3. **Карта пристроїв** — Leaflet.js + OpenStreetMap, маркери на координатах
4. **Список submissions** — table з останніми 50, link на Etherscan
5. **Графік активності** — стовпчики submission-ів за день (Chart.js)

Все це — **read-only**. Жодних wallets, transactions, форм для submit. Pure observability.

---

## 6. Що Phase 5 НЕ покриває

Свідомо out-of-scope:

- **Real-time push** — користувач має refresh-ити сторінку. Subgraph polling має ~30 sec lag від chain.
- **Authentication / paid features** — все публічне.
- **Mutation** (write data) — це pure read-only frontend.
- **Validation outcome у dashboard** — ensemble status, anomaly flags. Це у Postgres hypertable, **не на chain**, тому subgraph не бачить. Майбутній Phase може додати окремий API endpoint.
- **Historical analytics** beyond simple aggregates. Якщо буде попит — окремий tool.

---

## 7. Технічні рішення які треба зафіксувати

### 7.1 Хостинг subgraph

**The Graph Studio** (studio.thegraph.com) — безкоштовний, official. Підтримує Sepolia. Для MVP — це.

Альтернативи (відкласти):
- Alchemy Subgraphs — інтегровано з їх RPC, теж free tier
- Self-hosted graph-node — Docker, full control, але overhead

### 7.2 Хостинг dashboard

**GitHub Pages** на gh-pages branch цього ж репо.
- Безкоштовно
- HTTPS автоматично
- URL: `https://sidliarchukpetro.github.io/infraveritas-energy/`
- Якщо infraveritas.pro доступний — DNS CNAME на gh-pages

### 7.3 Subgraph startBlock

Subgraph manifest потребує startBlock — від якого блоку індексувати. Якщо startBlock=0 — повний Sepolia history (тижні crawl). Якщо startBlock=поточний — пропустимо існуючі submissions.

**Рішення:** знайти deploy block V3 на Etherscan, використати його. Тарас має знати точну дату deploy через tx hash.

```
URL: https://sepolia.etherscan.io/address/0xf21d900e43214b0abf489f8d6862352aabb09da3
Шукаємо: "First transaction" → block number
```

Це 30 сек роботи перед drop 5c (deployment).

### 7.4 Назва subgraph

Пропоную: `infraveritas-energy-sepolia`. Чітко вказує мережу.

Studio URL буде типу: `https://api.thegraph.com/subgraphs/name/sidliarchukpetro/infraveritas-energy-sepolia` (точний URL після deploy).

---

## 8. Open questions для тебе

1. **Domain для dashboard.** Розгорнути на `<github>.io` чи отримати subdomain від `infraveritas.pro`? Перше — швидко. Друге — кращий брендинг для investor pitch.

2. **Multi-network support зараз чи потім?** Якщо колись deploy V3 на mainnet — окремий subgraph чи один з config. Для MVP — окремий, простіше.

3. **`postDisconnection` highlighting у dashboard.** Чи варто візуально виділяти ці submissions (червоний tag, "reconnected after gap")? Це може бути важлива метрика для compliance.

4. **Public або token-gated GraphQL?** The Graph Studio підтримує API keys. Для MVP — публічний (read-only, anonymized — на chain все одно публічне). Якщо колись захочемо rate-limit — додамо.

---

## 9. Наступні кроки

1. Ти читаєш цей doc, погоджуєшся / правиш scope
2. Я пишу **drop 5a** — subgraph package з schema + обробниками. Локальний тест через graph-node Docker. 2-3 години.
3. Після successful 5a — **drop 5b** (агрегати), потім **5c** (deployment), потім **5d** (dashboard).

Альтернатива — **skip 5d** і просто залишити GraphQL endpoint як public API. Якщо investor хоче бачити дані, він може query GraphQL напряму через playground або curl. Це **75% cheaper** ніж писати dashboard, але гірший UX. Можна dashboard додати пізніше якщо буде попит.

---

**Чекаю твою реакцію перед стартом 5a.**
