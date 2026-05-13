# Aggregator v2 Design — InfraVeritas Energy

**Статус:** Draft v0.2 (V3 alignment корекція - lat/lon/light/total_energy_mwh у public inputs)
**Дата:** 2026-05-13
**Автор:** Petro Sydliarchuk
**Stage:** MVP Plan v1.4 — Етап 5 (передбачається після завершення Етапу 3 v08 circuit)

---

## 1. Призначення та межі

Aggregator — це сервіс поза мережею що приймає підписані виміри від edge-пристроїв, генерує доказ з нульовим розголошенням (ZK proof), і подає його у смарт-контракт `EnergyProofRegistryV3` на Sepolia (потім mainnet).

**Що aggregator робить:**

- Приймає підписані payload-и від edge-пристроїв через мережу
- Перевіряє локально цілісність payload-у і коректність підпису
- Реконструює канонічне представлення (2456 байт → 307 елементів поля BN254)
- Обчислює Poseidon sponge hash (має співпасти з тим що порахував edge)
- Генерує ZK-доказ через Noir-схему v08 (witness: приватні дані payload-у, public input: hash + device ID)
- Викликає `submitProof` на V3-контракті з proof-ом і публічними інпутами
- Логує транзакцію і повертає клієнту chain confirmation

**Чого aggregator НЕ робить:**

- Не зберігає приватні ключі edge-пристроїв (підписи робить edge, aggregator тільки перевіряє)
- Не вирішує які пристрої авторизовані (це робить `DeviceRegistry` on-chain)
- Не маніпулює виміри (canonical payload immutable після підпису)
- Не служить як storage базою — payload-и записуються on-chain через V3, off-chain БД тільки для tracking операцій

---

## 2. Розташування у системі
Aggregator стоїть між edge і V3. Він не довірений посередник — V3 контракт сам перевіряє Honk proof і P-256 підпис, тому aggregator не може підробити дані: якщо змінить payload, proof більше не валідуватиметься.


---

## 3. Інтерфейси

Aggregator має три точки контакту. Кожна — окремий контракт на дані.

### 3.1 Edge → Aggregator

Edge надсилає підписаний payload через HTTP POST. JSON-тіло:

| Поле | Тип | Опис |
|---|---|---|
| `payload.device_id` | uint64 | Унікальний ID пристрою |
| `payload.session_id` | uint64 | Монотонічний лічильник сесій |
| `payload.epoch_start_ts` | uint64 | Unix timestamp початку епохи |
| `payload.lat_e7` | int64 | Широта × 10^7 |
| `payload.lon_e7` | int64 | Довгота × 10^7 |
| `payload.light_level` | uint64 | Освітленість (опціонально) |
| `payload.tamper_flag` | uint64 | 0=OK, інакше — спрацював датчик втручання |
| `payload.readings` | arr[100] | Масив рівно 100 вимірів |
| `payload.readings[i]` | obj | `{voltage_mv, current_ma, timestamp_ms}` |
| `signature` | hex(64) | P-256: r \|\| s, без DER |
| `public_key` | hex(64) | P-256: X \|\| Y, uncompressed без 0x04 |

Відповідь — `202 Accepted` (у черзі) або `400 Bad Request` з кодом помилки.

Після обробки on-chain — callback `POST /confirmations` з tx hash, або polling `GET /submissions/{session_key}`.

### 3.2 Aggregator → Noir circuit (witness)

Aggregator готує witness file для Noir v08 circuit.

**Public inputs** (9 полів у точному порядку V3.PublicInputs struct):

1. `device_id` (Field as uint64)
2. `session_id` (Field as uint64)
3. `epoch_start_ts` (Field as uint64)
4. `lat_e7` (Field as int64) — широта × 10^7
5. `lon_e7` (Field as int64) — довгота × 10^7
6. `light_level` (Field as uint64)
7. `tamper_flag` (Field as uint64)
8. `payload_hash` (Field, 32 байти)
9. `total_energy_mwh` (Field as uint64)

**Privacy rationale:** location (lat, lon), light level і total energy — public (не private). InfraVeritas — RWA verification протокол; інвестори і auditors мають бачити location і energy claims активу. Privacy-oriented circuit (v09+) можна додати пізніше якщо emergent regulatory or operational requirements.

**Private inputs** (witness, не утікають у proof):

- `canonical_payload` ([Field; 307]) — повний payload розпакований
- `signature` ([u8; 64]) — P-256 ECDSA: r 32 байти || s 32 байти. **Має бути low-s normalized** (Noir `std::ecdsa_secp256r1::verify_signature` відхиляє high-s)
- `pubkey_x`, `pubkey_y` ([u8; 32]) — P-256 public key X || Y, big-endian

**Constraints які circuit enforce-ить (4 checks):**

1. `Poseidon::sponge(canonical_payload) == payload_hash`
2. Metadata destructuring: `canonical_payload[0..7]` повинні equal до 7 public metadata inputs відповідно
3. P-256 ECDSA verify: підпис валідний для `payload_hash` як 32 BE байти під ключем `(pubkey_x, pubkey_y)`
4. Energy sum: `sum(canonical_payload[7+i*3] * canonical_payload[8+i*3] for i in 0..100) == total_energy_mwh`

**Implementation:** `zk/circuits/v08/src/main.nr` (31,382 ACIR opcodes total)

### 3.3 Aggregator → V3 (submitProof)

Виклик функції контракту `submitProof(PublicInputs pi, bytes32 payloadHash, bytes signature, bytes devicePubkey, bytes honkProof)` з модифікатором `onlyRole(OPERATOR_ROLE)`.

Aggregator повинен:

- Мати акаунт з `OPERATOR_ROLE` (видається через `grantRole`)
- Тримати достатньо ETH/Sepolia ETH для gas (оцінка ~500k gas на одну submission)
- Логувати tx hash і event дані для аудиту off-chain
- Обробити revert: якщо контракт reject-нув (наприклад, P-256 verify fail або gap > MAX), повернути edge-у відповідну помилку через callback

---

## 4. Технологічний вибір

**Мова:** TypeScript на Node.js (LTS 20.x).

**Аргумент:** єдина зріла екосистема де є водночас `circomlibjs` (Poseidon для Circom-сумісних BN254 параметрів), Noir прив'язки через `@noir-lang/noir_js` та `@aztec/bb.js` для генерації Honk proof-ів, і `ethers.js` v6 / `viem` для виклику смарт-контрактів. Альтернативи (Rust, Python) потребували б або портувати proof-генерацію вручну, або відсутні зрілі прив'язки до Honk.

**Ключові бібліотеки:**

- `circomlibjs` — Poseidon hash, має дати bit-exact match з edge Python і Noir circuit
- `@noir-lang/noir_js` — компіляція circuit і генерація witness
- `@aztec/bb.js` — backend Barretenberg для генерації Honk proof
- `viem` v2 — interaction з V3 контрактом, signature verification локально
- `fastify` v5 — HTTP сервер
- `pino` — структуроване логування

**Версії заморожуються через `package-lock.json` для відтворюваності.**

---

## 5. Внутрішня структура модулів

Кодова база ділиться на 5 модулів у директорії `aggregator/src/`:

- **`api/`** — HTTP-обробники: `POST /submissions` приймає payload від edge, `GET /submissions/:key` повертає статус. Реалізовано на `fastify`
- **`verify/`** — локальна перевірка перед proof-генерацією: реконструкція канонічних 2456 байт (`canonical.ts`), Poseidon hash через circomlibjs (`poseidon.ts`), P-256 signature verify через WebCrypto (`p256.ts`)
- **`prover/`** — генерація ZK-доказу: підготовка witness для Noir (`witness.ts`), Honk proof через `@aztec/bb.js` (`honk.ts`)
- **`chain/`** — виклик V3 контракту через `viem.writeContract` з retry-логікою і обробкою revert-ів (`submit.ts`)
- **`queue/`** — черга submissions (in-memory у MVP, Redis у production для multi-instance)

Скомпільовані `.acir` файли circuit-у тримаються у `aggregator/circuits/` поза `src/` бо вони артефакти збірки.

Тести у `aggregator/tests/`: `unit/` для модулів окремо, `integration/` для end-to-end з мок V3, `crosslang/` для перевірки що Poseidon hash збігається з Python edge і Noir circuit для тих самих 9 авторитетних test vectors з `docs/specs/poseidon_test_vectors.json`.

---

## 6. Безпека: що aggregator може і чого не може

Aggregator — це сервіс що володіє `OPERATOR_ROLE` на V3-контракті, але не володіє приватними ключами edge-пристроїв. Це визначає його attack surface.

**Чого aggregator НЕ може:**

- Підробити payload — будь-яка зміна payload-у ламає Poseidon hash і Honk proof, V3 відхилить
- Підробити P-256 підпис — приватний ключ у HSM edge-пристрою, aggregator до нього не має доступу
- Authorize неіснуючий пристрій — DeviceRegistry on-chain, aggregator не контролює
- Bypass gap check — V3 порівнює `epoch_start_ts - lastSubmissionTimestamp` сам у контракті

**Що aggregator може зробити шкідливо:**

- DoS: відмовитися надсилати submissions від певних пристроїв (захист — multiple aggregator instances, edge може повторити через інший)
- Затримати submission щоб спрацював gap > MAX_GAP_SECONDS flag (захист — edge timeout retry на інший aggregator)
- Front-run власні транзакції (порядок подачі своїх submissions) — irrelevant для V3 семантики, не дає переваги
- Витік приватних даних з witness — circuit private inputs не публікуються on-chain, але якщо aggregator веде логи, payload видний у логах. Mitigation — не логувати raw payload, тільки hash і metadata

**Якщо OPERATOR_ROLE ключ скомпрометований:**

- Атакувальник може подавати submissions від імені operator-а, але тільки з ВАЛІДНИМИ proof-ами і підписами справжніх пристроїв (не може підробити)
- Атакувальник може робити DoS через flooding (захист — rate limiting у V3 контракті як можлива майбутня функція)
- Mitigation — admin може revoke role через `revokeRole(OPERATOR_ROLE)` і видати новий

---

## 7. Модель розгортання

**MVP (Етап 5):** один aggregator instance на operator, контейнеризовано через Docker. Self-hosted або на cloud-провайдері (DigitalOcean, Hetzner, AWS). Persistent storage не потрібен — стан тримається у пам'яті, фінальне джерело правди — V3 контракт on-chain.

**Production (post-MVP):**

- Multiple instances за load balancer-ом для high availability
- Redis для shared queue між instance-ами
- Окремий monitoring stack (Prometheus + Grafana)
- Окремий key management — `OPERATOR_ROLE` ключ у HSM або KMS, не у environment variables

**Вимоги до інфраструктури:**

- Node.js 20.x LTS
- 2 CPU, 4 GB RAM мінімум (proof generation важка)
- Стабільний RPC до Sepolia/mainnet (Infura, Alchemy, або self-hosted node)
- Sepolia/mainnet ETH для gas (~0.001 ETH на submission на mainnet, набагато менше на Sepolia)
- Outbound HTTPS для edge callbacks

---

## 8. Відкриті питання

- **Q1:** Multi-instance coordination — як уникнути подвійної подачі однієї submission? Через unique session_key (V3 контракт відхилить дублікат)?
- **Q2:** Aggregator key rotation — стратегія планової зміни `OPERATOR_ROLE` ключа без downtime
- **Q3:** Rate limiting — на якому шарі (V3 контракт, aggregator HTTP, або edge-side)
- **Q4:** Edge connection model — push (edge → aggregator HTTP) чи pull (aggregator → edge MQTT subscription). MVP — push, але для гірких environments (втрати з'єднання) pull може бути надійніше
- **Q5:** Logging policy — який мінімум деталей логувати щоб мати audit trail без витоку приватних payload даних
- **Q6:** Recovery після chain reorg — що робити якщо tx confirmed but reorged out на Sepolia/mainnet

---

**Кінець Aggregator v2 Design v0.1.**
