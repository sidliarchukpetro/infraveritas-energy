# V3 Contract — review questions для Олександра

**Для:** Олександр (CTO)
**Від:** Петро
**Дата:** 13.05.2026
**Стан:** V3 contract з повним submitProof body на main, CI green
**Очікувана робота:** ~30-45 хв (5-7 хв на питання × 6)
**Тип роботи:** async — кожне питання можна вирішити окремо, не потрібен sync call

---

## Контекст

V3 contract — EnergyProofRegistryV3 з 7-крокової submitProof verification. Імплементація закрита 12.05.2026 (7 commits на main, всі CI green).

**Ключові файли для review:**

- `contracts/src/EnergyProofRegistryV3.sol` — main contract (~280 рядків, з body)
- `contracts/src/interfaces/` — IDeviceRegistry, IP256Verifier, IHonkVerifier
- `docs/specs/V3_design.md` v0.2 — повний design з обґрунтуваннями
- `contracts/foundry.toml` — solc 0.8.28, viaIR, evm cancun

**Commits today для context:**
- a84166b (V3 design v0.1) → 4ac735d (v0.2) → 2d64198 (body)

**Що від тебе очікується:**

Для кожного з 6 питань нижче — або **підтвердити current default**, або **обрати іншу опцію з обґрунтуванням**. Це не блокує продовження роботи (defaults обрані як reasonable), але деякі питання важливі **до deployment на mainnet** (особливо Q2 timelock).

**Як надати відповідь:** або редагуєш цей файл прямо у repo (PR або direct push), або кидаєш мені у Telegram, або у GitHub Issue. Як зручніше.

---

## Q1. MAX_GAP_SECONDS — constant чи storage?

### Контекст

V3 має gap-checking механізм (L-004): якщо різниця між поточним і попереднім submission timestamp більша за MAX_GAP_SECONDS — submission позначається як `postDisconnection=true` у event. Зараз це **constant 48 годин** у контракті.

```solidity
uint64 public constant MAX_GAP_SECONDS = 48 hours;
```

### Опції

**А) Constant (current default).** Значення вшито у код, не можна змінити без UUPS upgrade контракту.

**Б) Storage variable з admin setter.** Адмін може tune-ити через `setMaxGapSeconds(uint64)`.

### Trade-offs

**А) Constant:**
- Дешевше gas (~3 gas vs ~2100 для SLOAD на кожен submitProof)
- Простіше — менше attack surface, менше функцій
- Якщо потрібна зміна — UUPS upgrade (admin-controlled, але heavyweight)

**Б) Storage:**
- Admin може швидко reagувати на operational issues (наприклад зимовий період коли legitimate gaps можуть бути більші)
- Regional варіації (різні країни мають різні patterns disconnection)
- +2100 gas/submission, новий attack vector (compromised admin може tune-ити MAX_GAP до нуля що блокує всіх)

### Current default: А

**Обґрунтування:** 48 годин — це **прапор постдисконекції**, не reject criterion. Submissions з gap > 48h приймаються, просто емітять flag для downstream review. Tune-ing через UUPS upgrade достатньо швидкий (4-6 годин timelock у production).

### Твоя відповідь

```
[ ] Підтверджую default А
[ ] Обираю Б (storage з admin setter) — обґрунтування: ___
[ ] Інше: ___
```

---

## Q2. setP256Verifier / setHonkVerifier — timelock? (highest stakes)

### Контекст

V3 має admin функції для заміни external dependencies (з міркувань upgradeability circuit):

```solidity
function setDeviceRegistry(address newRegistry) external onlyRole(DEFAULT_ADMIN_ROLE);
function setP256Verifier(address newVerifier) external onlyRole(DEFAULT_ADMIN_ROLE);
function setHonkVerifier(address newVerifier) external onlyRole(DEFAULT_ADMIN_ROLE);
```

**Все три setters — instant.** Немає timelock delay. Зараз `DEFAULT_ADMIN_ROLE` = EOA Петра (стартова конфігурація).

### Threat scenario

Якщо `DEFAULT_ADMIN_ROLE` компрометований (вкрадений ключ, social engineering, malicious multisig member):

- Attacker викликає `setHonkVerifier(maliciousVerifier)`
- maliciousVerifier завжди returns true
- Attacker submitне fake proofs які пройдуть всі 7 перевірок
- Reaction window — нуль секунд (transaction executes immediately)

### Опції

**А) Без timelock у V3 (current default).** Покладатись на майбутній external Timelock контракт у Етапі 8 (multisig pattern з 48-72h delay).

**Б) Timelock вбудований у V3.** Додати `pendingChange` mappings з 48h queue, два-крокова заміна (propose + execute).

**В) Гібрид.** Без timelock у V3, але `DEFAULT_ADMIN_ROLE` переноситься на external Timelock контракт перед mainnet deployment.

### Trade-offs

**А) Без timelock:**
- Simpler V3 contract (~50 рядків менше)
- Швидкий response якщо verifier має критичний bug і треба швидко swap
- **High risk** якщо admin компрометований
- Production-unsafe без B або C

**Б) Timelock у V3:**
- Self-contained security (не залежить від external Timelock)
- +200-400 gas на setX (mappings, comparisons)
- +50-80 рядків контракту
- Hard-coded 48h — не tune-able без upgrade

**В) Гібрид (external Timelock на mainnet):**
- V3 простий (як зараз)
- Timelock протекція є на production
- Залежить від Етап 8 multisig setup (deferred work)
- Testnet/Sepolia deploy без protection — OK, бо там немає реальної цінності

### Current default: А (з implicit рухом до В перед mainnet)

**Обґрунтування:** для MVP/testnet — instant setters прийнятно. Перед mainnet deployment (Етап 8) — `DEFAULT_ADMIN_ROLE` передається на Gnosis Safe 3-з-5 multisig з вбудованим Timelock 48h.

### Питання тобі

Чи ти OK з підходом А-з-міграцією-до-В? Чи варто **зараз** вкласти час у Б (timelock у V3) щоб не залежати від process step?

### Твоя відповідь

```
[ ] Підтверджую default А (плюс міграція до В перед mainnet)
[ ] Обираю Б (timelock у V3 contract) — додай у наступну ітерацію контракту
[ ] Інший підхід: ___
```

---

## Q3. `__gap[49]` — sufficient для майбутніх версій?

### Контекст

V3 inherits OZ upgradeable contracts. UUPS pattern вимагає `__gap` array для reserved storage slots, щоб майбутні версії могли додавати state без shift-у layout.

```solidity
// V3 own slots:
address public deviceRegistry;
address public p256Verifier;
address public honkVerifier;
mapping(bytes32 deviceId => uint64) public lastSubmissionTimestamp;
mapping(bytes32 sessionKey => bool) public usedSessionKeys;

uint256[49] private __gap;  // 49 reserved slots
```

49 reserved slots означає що V4, V5, V6 можуть додати **до 49 нових storage variables** без layout shift.

### Опції

**А) `__gap[49]` (current default, OZ-recommended).**

**Б) `__gap[100]` або більший резерв.**

**В) Менший gap (наприклад 30) — економія slots якщо planning more inheritance levels.**

### Trade-offs

**А) 49:**
- OZ default, добре протестований pattern
- 49 slots = 49 нових змінних — достатньо для більшості майбутніх extensions
- Storage layout — slots не "коштують" gas, тільки writes коштують. Reservation безкоштовна.

**Б) Більший резерв (100+):**
- Більше manevrove room
- Нуль практичної різниці у gas
- Просто "відкладені" слоти

**В) Менший резерв:**
- Підходить якщо ми очікуємо `__gap` зайнятий через V4 і потім ще inheritance levels (наприклад V3 → V3Extended → V3ExtendedV2)
- Економимо мало (storage layout decoration)

### Current default: А

**Обґрунтування:** OZ V5 patterns використовують 49-50 як standard. Адекватно для нашої roadmap (V4 — DeviceRegistry, V5 — Witness Network features, V6 — token integration). Кожна V — максимум 10-15 нових fields.

### Твоя відповідь

```
[ ] Підтверджую default А (__gap[49])
[ ] Збільшити до ___ slots — обґрунтування: ___
[ ] Інше: ___
```

---

## Q4. DeviceRegistry — upgradeable чи non-upgradeable?

### Контекст

DeviceRegistry — окремий контракт що буде написаний у тижні 5-6 Етапу 2 (зараз тільки interface і mock). Зберігає mapping authorized device pubkeys.

V3 викликає `IDeviceRegistry(deviceRegistry).isAuthorized(devicePubkey)` для авторизації.

### Опції

**А) Non-upgradeable (current default).** Стандартний контракт, immutable після deployment. Якщо потрібна зміна — deploy новий DeviceRegistry, V3 swaps via `setDeviceRegistry(newAddress)`.

**Б) Upgradeable (UUPS).** DeviceRegistry inherits UUPSUpgradeable, можна upgrade без зміни address.

### Trade-offs

**А) Non-upgradeable:**
- Простіший — менше code paths, легший аудит
- Bug → swap registry (втрачаємо state, потребує re-registration всіх devices)
- Auditor-friendly (immutable code)

**Б) Upgradeable:**
- Fix bugs без re-registration
- Більше attack surface (upgrade authorization)
- Storage layout constraints (як V3)
- Підказує "trust pattern" вже на DeviceRegistry рівні

### Current default: А

**Обґрунтування:** DeviceRegistry має просту логіку (mapping CRUD + role-based access). Bug ризик низький. Re-registration painful але manageable (всі devices мають їхні pubkeys у HSM, можна re-register batch операцією). Trust assumptions ясніші коли DeviceRegistry immutable.

### Питання тобі

Як ти оцінюєш складність DeviceRegistry — варто чи ні upgradeability комплексності для нього?

### Твоя відповідь

```
[ ] Підтверджую default А (non-upgradeable)
[ ] Обираю Б (UUPS upgradeable) — обґрунтування: ___
[ ] Гібрид (наприклад immutable у MVP, upgradeable у Phase 8): ___
```

---

## Q5. `isAuthorized` перевірка — on-chain чи aggregator-only?

### Контекст

V3.submitProof викликає `IDeviceRegistry(deviceRegistry).isAuthorized(devicePubkey)` — це **external view call**, ~3K gas додаткові на кожну submission.

### Опції

**А) On-chain check (current default).** V3 викликає DeviceRegistry перед іншими перевірками. Defense in depth.

**Б) Aggregator-only check.** Aggregator перевіряє authorization перед submit. V3 trustвує що тільки authorized aggregator submitне.

### Trade-offs

**А) On-chain:**
- Defense in depth — навіть compromised aggregator не може submitнути для unregistered device
- +3K gas/submission (~$0.0003 на Arbitrum, ~$0.10 на mainnet)
- Auditable (можна довести on-chain що device був authorized у момент submission)

**Б) Aggregator-only:**
- Економія 3K gas
- Trust assumption: aggregator чесний у authorization check
- Якщо aggregator компрометований — fake submissions можливі

### Current default: А

**Обґрунтування:** 3K gas — мізерна ціна. Aggregator compromise — realistic threat (single point of failure поки немає quorum у Етапі 5). Defense in depth justifies.

### Твоя відповідь

```
[ ] Підтверджую default А (on-chain)
[ ] Обираю Б (aggregator-only) — обґрунтування: ___
[ ] Інше: ___
```

---

## Q7. `usedSessionKeys` storage growth — TTL cap?

### Контекст

V3 зберігає `usedSessionKeys` mapping для replay protection:

```solidity
mapping(bytes32 sessionKey => bool used) public usedSessionKeys;
```

Кожна successful submission записує `usedSessionKeys[sessionKey] = true`. **Mapping ніколи не очищається**.

### Growth estimate

- 1 device × 24 submissions/day × 365 days = 8,760 entries/year/device
- 100 devices × 8,760 = 876,000 entries/year
- Кожен entry = SSTORE 20,000 gas (first time, 22,100 with refund) ≈ $0.002 на Arbitrum

Storage не deletes — mapping growth монотонний. На 10-річному horizon = 8.76M entries для 100-device deployment.

### Опції

**А) Без TTL (current default).** Mapping growsmonotonic. Усі historical sessionKeys збережені.

**Б) TTL cap.** Окремий cleanup function що видаляє entries старші за певний період (наприклад 1 рік). Adds complexity, але обмежує growth.

**В) Bitmap optimization.** Замість `bool` per entry — bitmap (255 sessions/slot). Економія storage, але requires sessionKey schema redesign.

### Trade-offs

**А) Без TTL:**
- Simplest implementation
- Permanent replay protection (можна перевірити будь-яку historic session)
- Growth manageable на realistic timeframes (10 років для 100 devices < 9M entries — нормально)

**Б) TTL cap:**
- Bounds storage
- Replay protection обмежена window (наприклад 1 рік)
- Гoutside-window sessions можна replay-нути (low risk бо anyway old)
- +complexity у contract

**В) Bitmap:**
- 255x storage compression
- Requires sessionId-based schema (sequential, not random)
- Refactor work

### Current default: А

**Обґрунтування:** для realistic scale (100-1000 devices), unbounded growth прийнятний. SSTORE cost — ~$0.002/submission на Arbitrum. Скільки б submissions не накопичилось — нікому це не "коштує" окрім storage rent (Ethereum не має storage rent зараз). Simpler — кращий MVP.

Якщо scale зросте до 10K+ devices — переходити на варіант В у V4/V5.

### Твоя відповідь

```
[ ] Підтверджую default А (без TTL)
[ ] Обираю Б (TTL cap) — період: ___
[ ] Обираю В (bitmap) — додати у наступну ітерацію
[ ] Інше: ___
```

---

## Загальні питання

### Чи у тебе є concerns про щось що я НЕ задав вище?

Список питань був складений з моєї перспективи дизайну. Якщо ти бачиш security/correctness issue який я пропустив — напиши тут.

```
[Місце для додаткових concerns]
```

### Чи готовий контракт по твоїй оцінці для:

```
[ ] Sepolia testnet deployment (поточний стан)
[ ] Mainnet деployment ПІСЛЯ Етап 8 (multisig + timelock + audit)
[ ] Mainnet deployment ПІСЛЯ виправлення наступного: ___
```

---

## Як надати відповідь

Три опції, обери що зручніше:

1. **Edit цей файл прямо у GitHub** (UI має кнопку "Edit"), commit з message `review: oleksandr v3 q-responses`, push або PR.
2. **Telegram сюди же** — copy-paste відповіді під відповідними питаннями.
3. **GitHub Issue** з посиланням на цей документ і відповідями.

---

## Підпис

**Документ створено:** 13 травня 2026
**Reviewer:** Олександр (CTO)
**Estimate review time:** 30-45 хвилин async

Дякую за час. Якщо щось неясно — питай у TG.
