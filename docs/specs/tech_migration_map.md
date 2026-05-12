# Технологічна карта міграції v1.3 → v1.4

**Дата:** 12 травня 2026 | **Версія:** 1.0
**Узгоджено:** v1.4 MVP Plan, ADR-002

Зіставлення компонентів і технологій до і після рішень v1.4 з указанням етапу реалізації.

## Smart contracts

| Старе (v1.3) | Нове (v1.4) | Етап |
|---|---|---|
| EnergyProofRegistry V2 (Hardhat) | V3 (Foundry, OZ) | 2 |
| Власна ownership | OZ AccessControl з emit events | 2 |
| Без gap-checking | mapping(deviceId→lastTimestamp), MAX_GAP=48h | 2 |
| Без Pausable | OZ Pausable | 2 |
| Без ReentrancyGuard | OZ ReentrancyGuard | 2 |
| Без DeviceRegistry | DeviceRegistry окремий контракт | 2 |
| Без P256Verifier | P256Verifier wrapper (secp256r1) | 3 |

## ZK schema

| Старе (v1.3) | Нове (v1.4) | Етап |
|---|---|---|
| v06: hash тільки readings | v08: повний canonical hash (всі поля) | 3 |
| Тільки secp256k1 | secp256k1 + secp256r1 (для ATECC608B) | 3 |
| Soundness не перевірений формально | Formal review перед v08 | 3 (pre-work) |

## Edge-пристрій

| Старе (v1.3) | Нове (v1.4) | Етап |
|---|---|---|
| edge_device.py Python mock | HAL: MockEdgeDevice (4a) + RaspberryPiEdgeDevice (4b) | 4 |
| Software secp256k1 ключ у файлі | ATECC608B HSM, secp256r1, ключ ніколи не покидає чіп | 4b |
| Без GPS | GPS NEO-6M (координати + точний час від атомних годинників) | 4b |
| Без tamper detection | 2 магнітні геркони через GPIO | 4b |
| AC-side PZEM | DC-side PZEM-016 (фізично унеможливлює мережеву атаку) | 4b |
| BH1750 датчик світла | ВИКЛЮЧЕНО (weather ensemble замість локального) | — |
| Без локального накопичення | SQLite на SD з GPS timestamps для offline-періодів | 4 |

## Aggregator (server-side)

| Старе (v1.3) | Нове (v1.4) | Етап |
|---|---|---|
| SQLite (single-file lock) | PostgreSQL + TimescaleDB | 5 |
| Subprocess calls у main thread | BullMQ worker pool + Redis | 5 |
| HTTPS без mTLS | mTLS з внутрішньою CA, edge cert у ATECC slot | 5 |
| Solcast як основа weather | Open-Meteo + NASA POWER + PVGIS ensemble | 6 |
| OpenWeather як fallback | ВИКЛЮЧЕНО (ensemble має внутрішню redundancy) | — |

## Безпека і governance

| Старе (v1.3) | Нове (v1.4) | Етап |
|---|---|---|
| Single private key | Gnosis Safe мультипідпис (3-з-5) | Після раунду |
| Без Timelock | OZ TimelockController (48-72h) | Після раунду |
| Без bug bounty | Immunefi програма | Після раунду |
| Без OperatorRegistry | OperatorRegistry SBT + KYC | Після раунду |

## Сервіси

| Старе (v1.3) | Нове (v1.4) | Етап |
|---|---|---|
| TDD сервіс для ECSP | ВИКЛЮЧЕНО (стратегічна зміна) | — |
| USPTO util
cat > docs/specs/v2_known_limitations.md << 'EOF'
# V2 known limitations (checklist для V3 design)

**Дата:** 12 травня 2026
**Контекст:** Етап 1 закрито. V2 у `contracts/legacy/v2/`. Цей документ — checklist коли пишемо V3 у Етапі 2. Кожне обмеження V2 повинно бути або вирішене, або свідомо залишене з обґрунтуванням.

## Контрактні обмеження V2

### L-001: Власна ownership без emit events
V2: `transferOwnership(address)` не emit event (F-002 у Slither baseline, medium severity).
V3: OZ `AccessControl` з role-based authorization. Автоматичні `RoleGranted` / `RoleRevoked` events.

### L-002: Без Pausable
V2: контракт не можна зупинити при incident.
V3: OZ `Pausable`. Owner викликає `pause()` для зупинки нових submissions; існуючі дані залишаються.

### L-003: Без ReentrancyGuard
V2: функції що змінюють state не захищені (поточно не критично, але для production-safety треба).
V3: OZ `ReentrancyGuard` на `submitProof()` і будь-якій функції з потенційним external call.

### L-004: Без gap-checking
V2: розриви у submissions не відстежуються.
V3: `mapping(deviceId => lastTimestamp)`. Якщо різниця > MAX_GAP (48h) → emit з `postDisconnection=true`. Aggregator робить посилену історичну перевірку для таких submissions.

### L-005: Без DeviceRegistry
V2: будь-який валідний підпис з будь-яким deviceId приймається.
V3: окремий `DeviceRegistry` контракт. `submitProof()` перевіряє `DeviceRegistry.isRegistered(deviceId)` → revert якщо ні.

### L-006: Тільки secp256k1, без secp256r1
V2: verify.ts через @noble/curves для secp256k1. ATECC608B (плановано Етап 4b) працює на secp256r1.
V3: P256Verifier wrapper. EnergyProofRegistry V3 вибирає verifier за `signatureScheme` у submission.

## ZK обмеження v06

### Z-001: Hash покриває тільки readings
v06: ZK proof hash — список readings, не повний payload.
v08: full canonical hash через blake2s (всі поля включно з timestamps, GPS). Унеможливлює заміну metadata без re-proving.

### Z-002: Soundness не перевірений формально
v06 deployed і приймає proofs, але формального аудиту constraints не було. Якщо є помилка soundness — система приймає fake data.
**Pre-Етап 3 task:** `docs/specs/zk_v06_review.md` (TBD) — формальний review constraints перед написанням v08.

## Edge обмеження

### E-001: Software signing замість HSM
V1 edge: ключ secp256k1 у файлі. Крадіжка Pi → копія ключа.
V3 edge (Етап 4b): ATECC608B. Ключ генерується у чіпі, ніколи не виходить.

### E-002: Час від системних годинників Pi
V1: timestamp з `time.time()`. Pi може фальсифікувати час.
V3 (Етап 4b): GPS NEO-6M timestamp (атомні годинники супутників).

### E-003: Без локального накопичення
V1: offline → submissions губляться.
V3 (Етап 4): SQLite на SD з GPS timestamps. При відновленні зв'язку — поодинці з оригінальними timestamps. Aggregator → посилена перевірка для post-disconnection.

### E-004: Без tamper detection
V1: відкриття корпусу не виявляється.
V3 (Етап 4b): два магнітні геркони. При відкритті — `tamperFlag=1` у всіх наступних submissions.

### E-005: AC-side вимірювання
V1: PZEM на AC сторону (вразливо до атаки "нічна електрика з мережі продається як сонячна").
V3 (Етап 4b): PZEM на DC сторону. Фізична неможливість подати з мережі у DC коло.

## Aggregator обмеження V1

### A-001: SQLite single-point-of-failure
V1: better-sqlite3, file lock при concurrent writes.
V2 (Етап 5): PostgreSQL + TimescaleDB.

### A-002: Без worker pool
V1: signature verify + ZK prove + chain submission у main thread Express.
V2 (Етап 5): BullMQ + Redis з окремими workers.

### A-003: Без mTLS edge↔aggregator
V1: server-side TLS, edge може бути будь-хто з network access.
V2 (Етап 5): mTLS, кожен edge cert у ATECC slot 1, підписаний нашою CA.

### A-004: Solcast як single weather dependency
V1: Solcast commercial API, single point of failure для trust layer.
V2 (Етап 6): ensemble з Open-Meteo + NASA POWER + PVGIS. Розходження між джерелами — сигнал аномалії.

## Threat model gaps

З 38 атак (Explanatory Note v1.0), які НЕ закриті у V2/V1:

- Нічна генерація через мережу (потребує DC PZEM + gap-checking + ensemble historical)
- Крадіжка Pi у нове місце (потребує GPS координати + DeviceRegistry)
- Ліхтарик на BH1750 (виключено, BH1750 не використовується)
- Відключи інтернет / маніпулюй / надішли заднім числом (потребує gap-checking + ensemble historical + tamper switches)
- Підміна координат (потребує GPS hardware)
- Відкриття корпусу (потребує tamper switches)

Повний 38-attack mapping — Етап 7 як автоматизований test suite.

## Чек-лист для V3 design

- [ ] L-001 до L-006 — кожне адресовано у коді або обґрунтовано чому пропущено
- [ ] V3 проходить Slither з суворішими правилами ніж V2 (F-002 закритий)
- [ ] Foundry test coverage для нових функцій (gap-checking, AccessControl, DeviceRegistry interaction) — мінімум 80%
- [ ] Gas costs порівняння V2 vs V3 (без значного зростання)
- [ ] Backward compatibility з V2 deployed на Sepolia не обов'язкова (testnet)

## Перегляд

Цей документ перевіряється після написання V3 (Етап 2 review). Кожне обмеження НЕ адресоване → у backlog з обґрунтуванням.
