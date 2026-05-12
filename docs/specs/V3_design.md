# V3 Design — EnergyProofRegistryV3

**Статус:** Draft v0.1
**Дата:** 2026-05-12
**Автор:** Petro Sydliarchuk
**Reviewers:** Oleksandr (security review), Taras (test plan)
**Stage:** MVP Plan v1.4 — Етап 2 (тижні 3-7)
**Closes:** L-001 … L-006 з `docs/specs/v2_known_limitations.md`

---

## 1. Скоуп

Концептуальний дизайн перед написанням Solidity. Документ містить рішення про контракти, ролі, mappings, events, errors, gas estimates і Foundry test plan. НЕ містить готових Solidity-реалізацій — це наступний крок після review.

**У скоупі:**
- L-001 — OpenZeppelin AccessControl замість власної ownership
- L-002 — OpenZeppelin Pausable
- L-003 — OpenZeppelin ReentrancyGuard
- L-004 — Gap-checking механізм (новий)
- L-005 — DeviceRegistry як окремий контракт
- L-006 — P256Verifier wrapper

**Deferred у наступні тижні Етапу 2:**
- EIP-712 typed signing (тиждень 5)
- Per-device rate limit on-chain (тиждень 5)
- UUPS proxy concrete setup і tests (тиждень 6)
- Echidna invariant testing (тиждень 7)

**Не у скоупі взагалі (інші етапи):**
- ZK v08 і HonkVerifier swap (Етап 3)
- ATECC608B integration (Етап 4b)
- Aggregator переробка (Етап 5)
- Edge HAL (Етап 4a паралельно)

---

## 2. Топологія контрактів

Три контракти:

```
┌─────────────────────────────────┐
│   EnergyProofRegistryV3         │  ← UUPS proxy + implementation
│   (main, behind proxy)          │
└──────┬──────────────────┬───────┘
       │                  │
       │ isActive()       │ verify(...)
       │ getPublicKey()   │
       ↓                  ↓
┌──────────────┐  ┌─────────────────┐
│ DeviceRegistry│  │ P256Verifier    │
│ (standalone)  │  │ (wrapper iface) │
└──────────────┘  └─────────────────┘
```

**Чому не один контракт:**

- **DeviceRegistry окремо** — для майбутнього sharing з іншими контрактами (V4, building inspection extension). Реєстри devices в EVM-екосистемі часто шарять. Аудит-friendly — два файли по 200-300 рядків замість одного на 800+.
- **P256Verifier окремо** — secp256r1 не у EVM precompile (EIP-7212 proposal stage). Поточні Solidity-реалізації (Daimo, FCL) gas-heavy. Wrapper дозволяє swap implementation коли з'явиться precompile, без чіпання основного контракту.

**Inter-contract calls у submitProof:**
- `DeviceRegistry.isActive(deviceId)` — view, ~3K gas
- `DeviceRegistry.getPublicKey(deviceId)` — view, ~3K gas
- `P256Verifier.verify(...)` — view but heavy, ~300-400K gas

---

## 3. L-001: AccessControl

V2 використовує власну ownership pattern (одна owner адреса). V3 переходить на OZ `AccessControlUpgradeable` з ієрархією ролей.

**Ролі:**

| Роль | Призначення | Holder |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Root, grant/revoke всі інші ролі | Multisig (на старті EOA Петра; перед mainnet — Gnosis Safe 3-з-5, Етап 8) |
| `OPERATOR_ROLE` | `submitProof` | Адреси aggregator instances |
| `PAUSER_ROLE` | `pause()` | Підмножина multisig (швидке реагування) |
| `UPGRADER_ROLE` | `_authorizeUpgrade` (UUPS) | DEFAULT_ADMIN_ROLE multisig only |

**Method gating:**

| Method | Role |
|---|---|
| `submitProof` | `OPERATOR_ROLE` |
| `pause` | `PAUSER_ROLE` |
| `unpause` | `DEFAULT_ADMIN_ROLE` |
| `setDeviceRegistry` | `DEFAULT_ADMIN_ROLE` |
| `setP256Verifier` | `DEFAULT_ADMIN_ROLE` |
| `_authorizeUpgrade` | `UPGRADER_ROLE` |

**Чому unpause вимагає вищу роль ніж pause:**
Asymmetric pattern — швидка пауза при загрозі (low friction), обережне відновлення (high friction). Це стандартний OZ pattern, не власна вигадка.

**Чому розділяти OPERATOR і PAUSER:**
Aggregator має власний ключ (hot, низький trust level). PAUSER має бути людина / multisig (cold, високий trust). Розділення мінімізує blast radius при компрометації aggregator key.

---

## 4. L-002: Pausable

`PausableUpgradeable` з OZ v5.

**Pause впливає на:**
- `submitProof` — модифікатор `whenNotPaused`

**Pause НЕ впливає на:**
- Role management (`grantRole`, `revokeRole`) — admin functions працюють завжди
- `pause` / `unpause` самі по собі
- View functions

**API:**
- `pause()` — `onlyRole(PAUSER_ROLE)`
- `unpause()` — `onlyRole(DEFAULT_ADMIN_ROLE)`
- `paused()` — inherited view from OZ

**Events:** `Paused(account)`, `Unpaused(account)` — inherited from OZ.

**Use cases:**
- Виявлено критичну вразливість → pause → патч → audit → unpause
- Operator key compromised → pause до ротації ключа

---

## 5. L-003: ReentrancyGuard

`ReentrancyGuardUpgradeable` з OZ v5.

**`nonReentrant` модифікатор на:**
- `submitProof` — робить external calls до DeviceRegistry і P256Verifier

**Чому додаємо навіть якщо external calls — view:**
- Майбутні зміни (callback, hook) можуть стати state-changing
- Slither може скаржитися без guard
- Захист проти SWC-107 patterns у future iterations
- Cost ~2K gas — negligible

**НЕ додаємо на:**
- Pure view functions (нема state mutation)
- Admin functions (single-call, не reentrant by nature)

---

## 6. L-004: Gap-checking — НОВИЙ механізм

Цей розділ — найбільший новий логічний матеріал у V3. У V2 механізму немає.

**Призначення:**
Детектувати чи device був offline довше ніж `MAX_GAP_SECONDS` і позначати наступні submissions як `postDisconnection`. Зовнішні системи (aggregator, dashboard, manual review) можуть піддавати postDisconnection submissions додатковому скрутіну.

**Storage:**

```solidity
mapping(bytes32 deviceId => uint64 timestamp) public lastSubmissionTimestamp;
```

**Constant (відкрите питання — див. §16):**

```solidity
uint64 public constant MAX_GAP_SECONDS = 48 hours;  // 172800
```

**Logic у submitProof (псевдокод):**

```
1. previous = lastSubmissionTimestamp[deviceId]
2. newTimestamp = proof.timestamp  // verified by ZK
3. if previous == 0:
       postDisconnection = false       // first submission
   elif newTimestamp <= previous:
       revert InvalidTimestamp         // anti-replay
   else:
       gap = newTimestamp - previous
       postDisconnection = (gap > MAX_GAP_SECONDS)
4. lastSubmissionTimestamp[deviceId] = newTimestamp
5. emit ProofSubmitted(deviceId, sessionKey, newTimestamp, gap, postDisconnection)
```

**Edge cases:**

| Сценарій | Поведінка |
|---|---|
| Перша submission (previous=0) | postDisconnection = false |
| `newTimestamp < previous` | revert `InvalidTimestamp` |
| `newTimestamp == previous` | revert `InvalidTimestamp` (anti-replay overlap із sessionKey) |
| `gap == MAX_GAP_SECONDS` (exactly 48h) | postDisconnection = false (`>`, not `>=`) |
| `gap == MAX_GAP_SECONDS + 1` | postDisconnection = true |
| `gap >> MAX_GAP_SECONDS` (7 days) | postDisconnection = true, lastSubmissionTimestamp оновлено |

**Why postDisconnection — flag, не block:**

Не блокуємо submission — legitimate device може мати offline period (debugging, hardware update, power outage). Сигналізуємо downstream, не on-chain rejection. On-chain rejection — занадто rigid policy для конфігурування з контракту.

**Boundary logic — `>` not `>=`:**

Explicit choice. Якщо edge сидить рівно 48 годин offline і submit-ить — це boundary OK, не disconnection. Запобігає false positives на borderline cases.

---

## 7. L-005: DeviceRegistry

Окремий контракт. **Non-upgradeable у MVP** (рішення — див. §16, open question 4).

**Storage:**

```solidity
struct Device {
    bytes publicKey;     // 64 bytes — secp256r1 X || Y (P-256)
    address owner;
    uint64 registeredAt;
    bool isActive;
}

mapping(bytes32 deviceId => Device) private devices;
```

**Ролі:**
- `DEFAULT_ADMIN_ROLE` — root
- `REGISTRAR_ROLE` — додає, деактивує, реактивує devices (на старті — Петро; пізніше — onboarded operator inspectors з Етапу 9)

**Interface:**

```solidity
interface IDeviceRegistry {
    function isActive(bytes32 deviceId) external view returns (bool);
    function getPublicKey(bytes32 deviceId) external view returns (bytes memory);
    function getDevice(bytes32 deviceId) external view returns (Device memory);
}
```

**Mutators:**
- `registerDevice(bytes32 deviceId, bytes calldata publicKey, address owner)` — `onlyRole(REGISTRAR_ROLE)`
- `deactivateDevice(bytes32 deviceId)` — `onlyRole(REGISTRAR_ROLE)`
- `reactivateDevice(bytes32 deviceId)` — `onlyRole(REGISTRAR_ROLE)`

**Events:**
- `DeviceRegistered(bytes32 indexed deviceId, bytes publicKey, address indexed owner, uint64 timestamp)`
- `DeviceDeactivated(bytes32 indexed deviceId, uint64 timestamp)`
- `DeviceReactivated(bytes32 indexed deviceId, uint64 timestamp)`

**Інтеграція з V3:**

```solidity
// у V3 storage
address public deviceRegistry;

// у submitProof
if (!IDeviceRegistry(deviceRegistry).isActive(deviceId)) {
    revert DeviceNotActive(deviceId);
}
bytes memory pubKey = IDeviceRegistry(deviceRegistry).getPublicKey(deviceId);
// далі P256Verifier.verify використовує pubKey
```

V3 може swap registry через `setDeviceRegistry(address newRegistry)` — `onlyRole(DEFAULT_ADMIN_ROLE)`.

---

## 8. L-006: P256Verifier wrapper

**Призначення:** verify secp256r1 (P-256) signatures, які створює ATECC608B чіп.

**Контекст:** EVM не має precompile для P-256. EIP-7212 у proposal stage, не deployed на більшості chains. Solidity implementations gas-heavy.

**Interface:**

```solidity
interface IP256Verifier {
    function verify(
        bytes32 messageHash,
        bytes32 r,
        bytes32 s,
        bytes32 pubKeyX,
        bytes32 pubKeyY
    ) external view returns (bool);
}
```

**Implementation options (рішення — Етап 3, тиждень 11):**
- **Daimo P256Verifier** — gas ~330K, audited (Veridise), deployed на multiple chains
- **FCL (Fresh Crypto Library)** — gas ~300K, less battle-tested
- **EIP-7212 precompile** — якщо/коли deployed на target chain (Arbitrum, Optimism)

**V3 storage:**

```solidity
address public p256Verifier;  // address of IP256Verifier implementation
```

**Mutator:**
- `setP256Verifier(address newVerifier)` — `onlyRole(DEFAULT_ADMIN_ROLE)`
- Reverts on `ZeroAddress` або `SameAddress(currentVerifier)`

**Event:** `P256VerifierChanged(address indexed oldVerifier, address indexed newVerifier)`

**У submitProof:**

```solidity
bool valid = IP256Verifier(p256Verifier).verify(
    messageHash, r, s, pubKeyX, pubKeyY
);
if (!valid) revert InvalidP256Signature();
```

**Чому wrapper, а не direct integration:**
- EIP-7212 deployment → swap implementation без перекомпіляції основного V3
- Daimo vs FCL рішення — не блокує V3 design
- Test isolation — mock на тестах

**Відкрите питання:** timelock на setP256Verifier (див. §16, q.2).

---

## 9. Storage layout (UUPS critical)

V3 inherits multiple OZ upgradeable contracts. Користувацький storage йде після inherited.

**Layout:**

```
// Inherited slots (managed by OZ — DO NOT TOUCH ORDER):
//   Initializable          — _initialized, _initializing
//   ContextUpgradeable     — (empty)
//   AccessControlUpgradeable — _roles mapping + reserved
//   PausableUpgradeable    — _paused
//   ReentrancyGuardUpgradeable — _status
//   UUPSUpgradeable        — (empty in OZ v5)

// V3 own slots (order matters for upgrades):
address public deviceRegistry;
address public p256Verifier;
mapping(bytes32 => uint64) public lastSubmissionTimestamp;
mapping(bytes32 => bool) public usedSessionKeys;

// Reserved gap for future versions:
uint256[50] private __gap;
```

**`__gap[50]` convention:**
- OZ standard для upgradeable contracts
- 50 reserved slots = до 50 нових storage variables у V4, V5 без зачіпання slot positions попередніх версій
- При додаванні нової variable у V4 — декрементуй gap відповідно (e.g., `uint256[49] __gap` якщо додав одну змінну)

**КРИТИЧНО:**
- НЕ змінювати порядок змінних у наступних версіях
- НЕ видаляти змінні (deprecated → залишити, не reuse slot)
- Нові змінні — ТІЛЬКИ В КІНЕЦЬ, перед `__gap`

---

## 10. Events

Повний список — для The Graph subgraph (Етап 7).

```solidity
event ProofSubmitted(
    bytes32 indexed deviceId,
    bytes32 indexed sessionKey,
    uint64 timestamp,
    uint64 gapFromPrevious,
    bool postDisconnection
);

event DeviceRegistryChanged(
    address indexed oldRegistry,
    address indexed newRegistry
);

event P256VerifierChanged(
    address indexed oldVerifier,
    address indexed newVerifier
);

// Inherited:
//   AccessControl: RoleGranted, RoleRevoked, RoleAdminChanged
//   Pausable:      Paused, Unpaused
//   UUPS:          Upgraded
```

**Чому `gapFromPrevious` як окреме поле, не тільки derived з `postDisconnection`:**
- Subgraph efficiently aggregates patterns (avg gap per device, distribution) без on-chain recomputation
- Auditor debugging — direct visibility замість inference

**Indexed fields choice:**
- `deviceId` — subgraph query by device
- `sessionKey` — anti-replay debugging
- `oldRegistry/newRegistry` etc. — admin audit trail filtering

---

## 11. Custom errors

OZ v5 використовує custom errors всюди (gas ~50 vs require strings).

**V3-specific:**

```solidity
error DeviceNotActive(bytes32 deviceId);
error InvalidTimestamp(uint64 provided, uint64 lastKnown);
error SessionKeyAlreadyUsed(bytes32 sessionKey);
error InvalidP256Signature();
error InvalidZKProof();
error ZeroAddress();
error SameAddress();
```

**Inherited (OZ v5):**
- `AccessControlUnauthorizedAccount`, `AccessControlBadConfirmation`
- `EnforcedPause`, `ExpectedPause`
- `ReentrancyGuardReentrantCall`

**Чому ZeroAddress і SameAddress на set*-functions:**
Defensive — admin випадково передасть 0x0 або поточну адресу. Cheap guard (no gas regret), explicit failure mode.

---

## 12. Gas estimation (rough)

**`submitProof` (hot path):**

| Component | Gas |
|---|---|
| AccessControl check | ~3K |
| `whenNotPaused` | ~2K |
| `nonReentrant` (entry+exit) | ~2K |
| `DeviceRegistry.isActive()` external view | ~3K |
| `DeviceRegistry.getPublicKey()` external view | ~3K |
| HonkVerifier ZK proof verification | ~400-600K |
| `P256Verifier.verify()` | ~300-400K |
| `usedSessionKeys` SLOAD+SSTORE | ~22K |
| `lastSubmissionTimestamp` SLOAD | ~2K |
| Gap math + comparison | ~1K |
| `lastSubmissionTimestamp` SSTORE (warm) | ~5K |
| Event emit | ~3K |
| **Rough total** | **~750K – 1050K gas** |

**Implications:**
- L1 Ethereum mainnet @ 30 gwei → ~$50-70/submission. Not viable economically.
- Arbitrum @ 0.1 gwei equivalent → ~$0.10-0.15/submission. Viable.
- Це підтверджує Arbitrum-first рішення з v1.3.

**Bytecode size estimation:**

| Component | Δ size |
|---|---|
| V2 baseline | ~16 KB |
| OZ AccessControl | +3-4 KB |
| OZ Pausable | +0.5 KB |
| OZ ReentrancyGuard | +0.3 KB |
| OZ UUPS | +1.5 KB |
| Custom errors (replace require strings) | -1 KB |
| Gap-checking logic | +0.5 KB |
| DeviceRegistry interaction | +0.5 KB |
| P256Verifier interaction | +0.5 KB |
| **Estimated total** | **~21-23 KB** |

**Risk:** впритул до EVM 24 KB ceiling. Це Risk 10.2 з v1.3.

**Mitigation якщо перевищить:**
- Винести gap math у library (link)
- Винести event-only logging helpers у library
- Decompose у facets — overkill для MVP, але crisis option

**Перевірка:** на тижні 4 після першого compilation, до того як писати submitProof body.

---

## 13. Foundry test plan

Test contracts:

```
test/V3_AccessControl.t.sol           (L-001)
test/V3_Pausable.t.sol                (L-002)
test/V3_ReentrancyGuard.t.sol         (L-003)
test/V3_GapChecking.t.sol             (L-004)
test/V3_DeviceRegistryIntegration.t.sol  (L-005)
test/V3_P256VerifierIntegration.t.sol    (L-006)
test/V3_Integration.t.sol             (end-to-end)
test/DeviceRegistry.t.sol             (standalone)
test/mocks/MockP256Verifier.sol       (controllable verifier)
test/mocks/MaliciousVerifier.sol      (reentrancy attacker)
```

**Per-limitation scenarios (Тарасу як specification):**

**L-001 AccessControl:**
- happyPath — operator submits, success
- unauthorized — non-operator → reverts `AccessControlUnauthorizedAccount`
- revokeRole — operator revoked → next submit reverts
- adminTransfer — DEFAULT_ADMIN_ROLE передано → old admin loses control
- pauserCannotUnpause — PAUSER role tries unpause → reverts
- selfDestruct guard — функції selfdestruct не існує (negative test by absence)

**L-002 Pausable:**
- pauseBlocksSubmit — paused → submit reverts `EnforcedPause`
- unpauseRestores — unpause → submit works
- nonPauserCannotPause — random wallet → reverts
- nonAdminCannotUnpause — PAUSER tries unpause → reverts

**L-003 ReentrancyGuard:**
- maliciousVerifier — P256Verifier mock reenters submit → reverts `ReentrancyGuardReentrantCall`
- maliciousRegistry — DeviceRegistry mock reenters → reverts

**L-004 Gap-checking (найбільше тестів):**
- firstSubmission — previous=0, postDisconnection=false
- gapUnderMax — 47h59m, postDisconnection=false
- gapExactlyMax — exactly 48h, postDisconnection=false (boundary)
- gapJustOver — 48h+1s, postDisconnection=true
- gapMuchOver — 7 days, postDisconnection=true
- timestampInPast — new < previous → reverts `InvalidTimestamp`
- timestampEqual — new == previous → reverts `InvalidTimestamp`
- multipleDevices — independent gap tracking per deviceId
- eventFields — `gapFromPrevious` matches calculation

**L-005 DeviceRegistry integration:**
- activeDeviceSubmits — registered + active → success
- inactiveDeviceReverts — deactivated → reverts `DeviceNotActive`
- unregisteredDeviceReverts — deviceId never registered → reverts
- swapRegistry — admin changes registry → new registry used
- swapToZeroReverts — `setDeviceRegistry(0)` → reverts `ZeroAddress`

**L-006 P256Verifier integration:**
- validSignature — real P-256 test vector → verifies
- invalidSignature — bad r/s → reverts `InvalidP256Signature`
- swapVerifier — admin changes verifier → new used
- swapToZeroReverts — `setP256Verifier(0)` → reverts

**Integration (V3_Integration.t.sol):**
- fullFlow — register → submit → second submit з gap → events correct
- pauseInterleave — pause mid-flow → subsequent submit blocks

**Coverage target:** >90% lines, >90% branches (per v1.3 §7.2).

---

## 14. Echidna invariants (preview для тижня 7)

Формулювання — finalized у тижні 7 під час Echidna setup. Зараз preview:

```
invariant_submitCounterMonotonic:
  кількість ProofSubmitted events для будь-якого deviceId
  є non-decreasing у часі

invariant_pausedMeansNoSubmit:
  якщо paused() == true,
  жоден ProofSubmitted event не emit-ається у тому ж блоці

invariant_sessionKeyUnique:
  для будь-якого sessionKey
  максимум один ProofSubmitted event з тим key

invariant_postDisconnectionMatchesGap:
  якщо ProofSubmitted.gapFromPrevious > MAX_GAP_SECONDS,
  то ProofSubmitted.postDisconnection == true

invariant_nonOperatorCannotSubmit:
  якщо msg.sender не має OPERATOR_ROLE,
  submitProof завжди revert-ує

invariant_timestampMonotonicPerDevice:
  для будь-якого deviceId
  ProofSubmitted.timestamp є strictly increasing
```

24-годинний прогон у тижні 7 — per v1.3 plan.

---

## 15. Відкриті питання для Олександрового review

Список питань на які потрібен security input ДО старту Solidity.

**Q1. `MAX_GAP_SECONDS` — constant чи storage?**
- Constant: економить gas (no SLOAD), але не змінюється без upgrade
- Storage (з admin setter): дозволяє tuning (зимовий період, регіональні відмінності), але attack surface +1
- **Поточне рішення design-у:** constant. Якщо знадобиться change — UUPS upgrade.

**Q2. `setP256Verifier` — timelock у V3 чи external Timelock у Етапі 8?**
- Adversary з компрометованим DEFAULT_ADMIN_ROLE може swap-нути на malicious verifier і затверджувати fake signatures
- 48h timelock у V3 дає reaction window
- Альтернатива: Gnosis Safe з Timelock Controller у Етапі 8 — multisig pattern
- **Trade-off:** timelock у V3 = +complexity у MVP; external = simpler V3, але якщо до Етапу 8 проходить 7+ місяців з deployed mainnet — window vulnerable

**Q3. `__gap[50]` — sufficient?**
- 50 slots = до 50 нових storage variables у V4/V5
- Чи передбачаємо V4 з >50 новими полями? Якщо так — збільшити до 80 або 100.
- **Поточне рішення:** 50, standard OZ default. Можна переоцінити пізніше.

**Q4. DeviceRegistry — upgradeable чи non-upgradeable?**
- Поточний design: non-upgradeable
- Якщо bug у DeviceRegistry → swap у V3 через `setDeviceRegistry(newAddress)`, але втрачаємо state (треба re-register все)
- Альтернатива: DeviceRegistry як UUPS — fix bug без re-registration, але +complexity
- **Питання:** яке прийнятне трохи більш risky?

**Q5. `isActive` перевірка — у V3 (on-chain) чи у aggregator (off-chain)?**
- Поточний design: V3 викликає DeviceRegistry.isActive() — +3K gas
- Альтернатива: aggregator перевіряє off-chain і не submit-ить якщо deactivated; V3 не перевіряє
- **Trade-off:** on-chain — сильніше, immune до compromised aggregator. Off-chain — економніше.
- **Recommendation:** залишити on-chain. 3K gas justifiable вартість для defense-in-depth.

**Q6. HonkVerifier у V3 — hardcoded чи через wrapper?**
- V3 інтегрує поточний HonkVerifier (under V2 ZK схема v06)
- ZK v08 deployment — Етап 3 — потребує нового HonkVerifier
- Опції:
  - (a) Hardcode address у V3 initializer, swap-ити через UUPS upgrade
  - (b) Wrapper (як P256Verifier) — settable address
- **Trade-off:** (a) — простіше, UUPS upgrade — це звичайний flow; (b) — більше flexibility, але один більше moving part
- **Recommendation:** (a). UUPS upgrade — natural mechanism, додатковий wrapper надмір.

**Q7. `usedSessionKeys` storage growth — кеп?**
- Mapping ніколи не очищається (replay protection)
- На 10K submissions/year × 20K gas SSTORE → ~$2K/year rent prepaid у submit costs
- Альтернатива: TTL механізм (sessionKey expires after 30 days; cleanup callable by anyone)
- **Recommendation:** залишити без кепу. Growth manageable, TTL adds complexity і atom-level coordination risk.

---

## 16. Out of scope для V3 design (deferred до наступних тижнів Етапу 2)

| Item | Тиждень | Чому не зараз |
|---|---|---|
| EIP-712 typed signing | 5 | Polish, не core security. Поточний raw sig OK для MVP |
| Per-device rate limit on-chain | 5 | Зараз rate limit у aggregator достатньо для anti-spam |
| UUPS proxy deployment scripts | 6 | Design передбачає UUPS, але scripts — окрема робота |
| Echidna invariant testing setup | 7 | Preview у §14, повна setup пізніше |

---

## 17. Наступні кроки після review

1. Олександр читає документ, відповідає на §15 (Q1-Q7) — orientation 1-2 години
2. Петро інтегрує decisions у V3 design — revision до v0.2
3. Тарас читає §13 — оцінює scope test plan, повертається з timing estimate
4. Перевірка bytecode size estimate на skeleton compile — тиждень 3 day 1-2
5. Якщо все green → Solidity start тиждень 3

---

**Кінець V3 design v0.1.**
