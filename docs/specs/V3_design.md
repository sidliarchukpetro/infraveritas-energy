# V3 Design — EnergyProofRegistryV3

**Статус:** Draft v0.3
**Дата:** 2026-05-13
**Автор:** Petro Sydliarchuk
**Reviewers:** Oleksandr (security review), Taras (test plan)
**Stage:** MVP Plan v1.4 — Етап 2 (тижні 3-7)
**Closes:** L-001 … L-006 з `docs/specs/v2_known_limitations.md`

---

## Changelog v0.2 → v0.3

- **DeviceRegistry implemented** (commit 8dd189b) — `contracts/src/DeviceRegistry.sol`, 24 unit tests у `contracts/test/DeviceRegistry.t.sol`, всі проходять
- **V3 + DeviceRegistry integration tests** (commit 1f575a6) — 9 тестів у `contracts/test/V3WithDeviceRegistry.t.sol` покривають authorization flow end-to-end (happy path, unregistered/revoked/suspended device, reactivation, multi-device independence)
- **Deployment scripts** (commit 6570aac) — `Deploy.s.sol`, `DeployLocal.s.sol`, `DeployDeviceRegistry.s.sol` плюс `.env.example` і `docs/deployment.md`. Локально перевірено end-to-end через anvil (повний стек розгорнутий, всі транзакції успішні)
- **CI workflow fix** (commit 67e3c14) — видалено `continue-on-error: true` з forge test step. До цього CI рапортував green незалежно від результатів тестів. Тепер CI signal надійний
- **Test setUp fix** (commit 2e09d40) — `vm.prank` gotcha у `DeviceRegistry.t.sol`: prank споживався першим external call (`registry.OPERATOR_ROLE()`), не доходив до `grantRole`. Виправлено через cache role у локальну змінну перед prank
- **§18 Q4 closed:** DeviceRegistry non-upgradeable confirmed
- **DeviceRegistry design deviation from v0.2 spec accepted:**
  - Назва ролі: `OPERATOR_ROLE` (не `REGISTRAR_ROLE`) — консистентно з `V3.OPERATOR_ROLE`
  - Device struct: dropped `owner address`, додано `int32 latE7`, `int32 lonE7` для майбутнього V4 geographic bounds checking (координати зберігаються внутрішньо, не експонуються через `IDeviceRegistry`)
  - Status: `DeviceStatus` enum (Unknown/Active/Revoked/Suspended) замість `bool isActive` — підтримує reactivate і suspend lifecycle
  - Owner tracking deferred to aggregator off-chain БД (V3 контракт не потребує owner для своїх 7 checks)

---

## Changelog v0.1 → v0.2

- **Hash function decision committed:** Poseidon (BN254) для v08+ circuit замість blake2s
- **HonkVerifier wrapper integration** — додано як третій external dependency у топології, mirror P256 pattern
- **submitProof signature finalized** per Architecture.docx target — `(PublicInputs, payloadHash, signature, devicePubkey, proof)`
- **Storage layout updated** — `honkVerifier` слот додано, `__gap[50]` → `__gap[49]`
- **Hardware clarification:** PZEM-017 для DC measurement (typo correction; Plan v1.3 і Architecture помилково писали "-016")
- **Bytecode estimate revised** — §12 переоцінено з 21-23 KB на 7-10 KB realistic (на основі measured 5,748 B на patched skeleton)
- **§15 Q6 closed** — HonkVerifier через wrapper, не hardcode
- **New custom errors** — `PayloadHashMismatch`, `EpochInFuture` додано для submit body checks

---

## 1. Скоуп

Концептуальний дизайн перед написанням Solidity body. Документ містить рішення про контракти, ролі, mappings, events, errors, gas estimates і Foundry test plan.

**У скоупі:**
- L-001 — OpenZeppelin AccessControl
- L-002 — OpenZeppelin Pausable
- L-003 — OpenZeppelin ReentrancyGuard
- L-004 — Gap-checking механізм
- L-005 — DeviceRegistry окремий контракт
- L-006 — P256Verifier wrapper
- HonkVerifier wrapper (новий, паралельний до L-006 pattern)

**Deferred у наступні тижні Етапу 2:**
- EIP-712 typed signing (тиждень 5)
- Per-device rate limit on-chain (тиждень 5)
- UUPS proxy concrete setup і tests (тиждень 6)
- Echidna invariant testing (тиждень 7)

**Не у скоупі взагалі (інші етапи):**
- ZK v08 circuit implementation (Етап 3, Олександр)
- ATECC608B integration (Етап 4b)
- Aggregator переробка (Етап 5)
- Edge HAL (Етап 4a паралельно)

---

## 2. Топологія контрактів

Чотири контракти (V3 main + три dependencies):

```
┌──────────────────────────────────┐
│   EnergyProofRegistryV3          │  ← UUPS proxy + implementation
│   (main, behind proxy)           │
└─────┬─────────────┬──────────────┘
      │             │             │
      │ isAuthorized│ verify(...) │ verify(...)
      │             │             │
      ↓             ↓             ↓
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│DeviceRegistry│ │ P256Verifier │ │ HonkVerifier │
│ (standalone) │ │  (wrapper)   │ │  (wrapper)   │
└──────────────┘ └──────────────┘ └──────────────┘
```

**Inter-contract calls у submitProof:**
- `DeviceRegistry.isAuthorized(devicePubkey)` — view, ~3K gas
- `P256Verifier.verify(payloadHash, signature, devicePubkey)` — view, ~300-400K gas (Daimo або FCL)
- `HonkVerifier.verify(proof, publicInputs)` — view, ~200-300K gas (auto-generated UltraHonk)

**Чому окремі контракти:**

- **DeviceRegistry окремо** — для майбутнього sharing з V4, building inspection extension. Аудит-friendly.
- **P256Verifier wrapper** — secp256r1 не у EVM precompile. EIP-7212/RIP-7212 у proposal stage. Wrapper дозволяє swap implementation коли precompile з'явиться.
- **HonkVerifier wrapper** — circuit ітеративно еволюціонує (v06 → v07_spike → v08 → майбутні). Кожна нова circuit генерує новий HonkVerifier. Wrapper дозволяє swap без upgrade V3 контракту.

---

## 3. Архітектурні рішення (committed 2026-05-12)

Цей розділ — це quick-reference для всіх non-trivial design-рішень які впливають на код але не задокументовані як окремі сектіони.

### 3.1 Hash function — Poseidon (BN254)

**Decision:** для v08+ Noir circuit і всіх downstream компонентів — **Poseidon hash** на curve BN254.

**Replaces:** blake2s (використовується у v06 circuit currently deployed).

**Why:**
- ~100x менше constraints у ZK circuit (Poseidon ~400 constraints vs blake2s ~30-40K)
- Менший HonkVerifier bytecode, нижчий gas
- Швидша proof generation (0.05s vs 1.5s)
- Industry standard для ZK ecosystem (Mina, Polygon zkEVM, Aztec, Filecoin)

**Parameter freeze (TBD by Олександр at v08 design):**
Стандартні параметри для нашого use case: BN254 field, t=3 (хешуємо 2 elements + 1 capacity), r_F=8 full rounds, r_P=56 partial rounds, alpha=5 (S-box exponent). **Олександр has final sign-off на конкретні параметри під час v08 circuit design (Етап 3, тиждень 8).**

**Cross-language consistency requirement:**
Parameter set MUST be identical across:
- Noir circuit (`std::hash::poseidon`)
- Aggregator TypeScript (`@aztec/foundation` Poseidon або `circomlibjs`)
- Edge Python (`poseidon-hash` PyPI або custom impl)

Любий mismatch → silent hash inconsistency → silent verification failure. **Critical to freeze before any of three components is implemented.**

**V3 contract impact:** жодного. Контракт hash-agnostic, тільки приймає `bytes32 payloadHash`.

### 3.2 Hardware — PZEM-017 для DC measurement

**Decision:** edge-пристрій використовує **PZEM-017** (DC voltage/current через shunt), не PZEM-016.

**Why:**
Architecture.docx Layer 6 і Plan v1.3 §3.1 описували "PZEM-016 на DC сторону панелі" — це internal typo. PZEM-**016** — AC measurement (через CT clamp). PZEM-**017** — DC measurement (через shunt). Архітектурний intent (захист від AC mains injection attack) вимагає DC, тобто -017.

**V3 contract impact:** жодного. Контракт не знає що міряється, тільки приймає readings у canonical payload.

**Edge software impact:** реальний — driver використовує інші Modbus register addresses для DC vs AC. Тарас при написанні edge_device_v2.py у Етапі 4 має використовувати PZEM-017 manual.

### 3.3 HonkVerifier integration — wrapper pattern (closes §15 Q6)

**Decision:** HonkVerifier інтегрується через **wrapper interface** (mirror P256Verifier pattern), не через hardcoded address у V3 implementation.

**Why:**
- Circuit еволюціонує (v06 → v08 → майбутні). Кожна version → новий HonkVerifier bytecode.
- Wrapper з settable address дозволяє swap implementation **без UUPS upgrade** V3 контракту.
- Architecture.docx target submitProof уже використовує цю pattern: `honkVerifier.verify(proof, encodePublicInputs(pubInputs))`.

**Storage:** `address public honkVerifier` (між `p256Verifier` і `lastSubmissionTimestamp`).
**Setter:** `setHonkVerifier(address)` — `onlyRole(DEFAULT_ADMIN_ROLE)`.
**Interface:** `IHonkVerifier.verify(bytes proof, bytes32[] publicInputs) → bool`.

---

## 4. L-001: AccessControl

V2 мав ownership pattern (single owner address). V3 переходить на OZ `AccessControlUpgradeable` з ієрархією ролей.

**Ролі:**

| Роль | Призначення | Holder |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Root, grant/revoke всі інші ролі | Multisig (на старті EOA Петра; перед mainnet — Gnosis Safe 3-з-5, Етап 8) |
| `OPERATOR_ROLE` | `submitProof` | Адреси aggregator instances |
| `PAUSER_ROLE` | `pause()` | Підмножина multisig |
| `UPGRADER_ROLE` | `_authorizeUpgrade` (UUPS) | DEFAULT_ADMIN_ROLE multisig only |

**Method gating:**

| Method | Role |
|---|---|
| `submitProof` | `OPERATOR_ROLE` |
| `pause` | `PAUSER_ROLE` |
| `unpause` | `DEFAULT_ADMIN_ROLE` |
| `setDeviceRegistry` | `DEFAULT_ADMIN_ROLE` |
| `setP256Verifier` | `DEFAULT_ADMIN_ROLE` |
| `setHonkVerifier` | `DEFAULT_ADMIN_ROLE` |
| `_authorizeUpgrade` | `UPGRADER_ROLE` |

**Asymmetric pause/unpause:** швидка пауза при загрозі (PAUSER), обережне відновлення (DEFAULT_ADMIN_ROLE). Стандартний OZ pattern.

---

## 5. L-002: Pausable

`PausableUpgradeable` з OZ v5.

**Pause впливає на:** `submitProof` (модифікатор `whenNotPaused`).
**Не впливає на:** role management, view functions.

**API:** `pause()` (PAUSER_ROLE), `unpause()` (DEFAULT_ADMIN_ROLE), `paused()` view.

---

## 6. L-003: ReentrancyGuard

`ReentrancyGuardUpgradeable` з OZ v5. `nonReentrant` модифікатор на `submitProof` (робить external calls до DeviceRegistry, P256Verifier, HonkVerifier).

**Версія guard:** регулярний (storage-based). Transient версія (`ReentrancyGuardTransient` з OZ v5.1+) deferred — re-evaluate перед mainnet deployment (Phase 11).

---

## 7. L-004: Gap-checking механізм

**Призначення:** детектувати чи device був offline довше ніж `MAX_GAP_SECONDS` і позначати наступні submissions як `postDisconnection`. Downstream системи (aggregator, dashboard, manual review) можуть піддавати postDisconnection submissions додатковому скрутіну.

**Storage:**
```solidity
mapping(bytes32 deviceId => uint64 timestamp) public lastSubmissionTimestamp;
uint64 public constant MAX_GAP_SECONDS = 48 hours;  // 172800
```

**Logic у submitProof (псевдокод):**

```
1. previous = lastSubmissionTimestamp[deviceId]
2. newTimestamp = pubInputs.epochStartTs
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
| `newTimestamp == previous` | revert `InvalidTimestamp` (anti-replay overlap with sessionKey) |
| `gap == MAX_GAP_SECONDS` (exactly 48h) | postDisconnection = false (`>`, not `>=`) |
| `gap == MAX_GAP_SECONDS + 1` | postDisconnection = true |

**postDisconnection — flag, не block.** Legitimate device може мати offline period (debugging, power outage). Сигналізуємо downstream без on-chain rejection — занадто rigid policy.

---

## 8. L-005: DeviceRegistry

**Status:** IMPLEMENTED (commit 8dd189b). Файл `contracts/src/DeviceRegistry.sol`, 24 unit tests у `contracts/test/DeviceRegistry.t.sol` (всі проходять), 9 integration tests з V3 у `contracts/test/V3WithDeviceRegistry.t.sol`.

Окремий контракт, **non-upgradeable у MVP** (закрите рішення — §18 Q4).

**Storage (актуально, deviation від v0.2 specs прийнята):**

```solidity
enum DeviceStatus { Unknown, Active, Revoked, Suspended }

struct Device {
    int32 latE7;          // зареєстровані координати (для V4+ GPS bounds check)
    int32 lonE7;
    uint64 registeredAt;
    DeviceStatus status;  // single slot pack: 4 + 4 + 8 + 1 = 17 bytes, fits in 32
}

mapping(bytes32 pubKeyHash => Device) private _devices;  // key: keccak256(publicKey)
uint256 public deviceCount;  // monotonic lifetime counter
```

**Deviations від v0.2 design:**

- Dropped `owner address` — ownership tracking deferred to aggregator off-chain БД. V3 контракт не потребує owner для своїх 7 checks
- Added `latE7`, `lonE7` — внутрішнє зберігання для майбутнього V4 geographic bounds checking. Координати **не експонуються** через IDeviceRegistry, тільки через окремі view функції (`getDeviceInfo`)
- `DeviceStatus` enum замість `bool isActive` — підтримує reactivate (revoked → active) і suspend (active → suspended → active) lifecycle, що `bool` не може виразити

**Ролі:**
- `DEFAULT_ADMIN_ROLE` — керує ролями (root)
- `OPERATOR_ROLE` — виконує lifecycle операції з пристроями (register, revoke, reactivate, suspend)

Назва `OPERATOR_ROLE` (не `REGISTRAR_ROLE` як у v0.2 specs) — консистентно з `V3.OPERATOR_ROLE`. Admin **не** отримує OPERATOR_ROLE автоматично — має явно grantRole собі або іншому акаунту.

**Interface (final, мінімальний):**

```solidity
interface IDeviceRegistry {
    function isAuthorized(bytes calldata publicKey) external view returns (bool);
}
```

**Чому інтерфейс мінімальний:**

`isAuthorized(pubkey) returns (bool)` — це все що V3 потребує. Координати, status, registeredAt — exposed через окремі view функції (`getDeviceInfo`, `getDeviceStatus`) **поза інтерфейсом IDeviceRegistry**. V3 контракт не запитує цих даних, тому розширення інтерфейсу до combined call (`authorize(pubkey, lat, lon)`) було б over-engineering — потребувало б змін V3 контракту без жодної реальної функціональної потреби сьогодні.

**Why pubkey-based, not deviceId-based:**
- Одна перевірка `isAuthorized(pubkey)` замість двох (`isActive(id)` + `getPublicKey(id)`)
- Pubkey і так у параметрах submitProof для P256 verify — не дублюємо lookup
- Pubkey є криптографічним identity, deviceId просто human-readable counter у pubInputs

`deviceId` (з PublicInputs) використовується для **event indexing** і **gap-checking** lookup у V3. `devicePubkey` — для verification у V3 і isAuthorized у DeviceRegistry.

**Operator functions:**
- `registerDevice(bytes publicKey, int32 latE7, int32 lonE7)` — валідує довжину pubkey (64 bytes) і координати у межах [-90°, +90°] × [-180°, +180°]
- `revokeDevice(bytes publicKey)` — status → Revoked
- `reactivateDevice(bytes publicKey)` — status → Active (from Revoked or Suspended)
- `suspendDevice(bytes publicKey)` — status → Suspended (from Active only)

Всі — `onlyRole(OPERATOR_ROLE)`.

**View functions (поза IDeviceRegistry):**
- `isAuthorized(bytes publicKey) returns (bool)` — IDeviceRegistry hot path
- `getDeviceInfo(bytes publicKey) returns (int32 lat, int32 lon, uint64 registeredAt, DeviceStatus)` — full metadata
- `getDeviceStatus(bytes publicKey) returns (DeviceStatus)` — short query
- `deviceCount() returns (uint256)` — monotonic lifetime counter

**Events:**
- `DeviceRegistered(bytes32 indexed pubKeyHash, int32 latE7, int32 lonE7, uint64 registeredAt, address indexed operator)`
- `DeviceRevoked(bytes32 indexed pubKeyHash, address indexed operator)`
- `DeviceReactivated(bytes32 indexed pubKeyHash, address indexed operator)`
- `DeviceSuspended(bytes32 indexed pubKeyHash, address indexed operator)`

Pubkey indexed як `keccak256` hash (32 bytes — fits у indexed topic). Operator address indexed для off-chain filtering за виконавцем.

**Integration з V3:**

```solidity
if (!IDeviceRegistry(deviceRegistry).isAuthorized(devicePubkey)) {
    revert DeviceNotActive(deviceIdBytes32);
}
```

V3 може swap registry: `setDeviceRegistry(address)` — `onlyRole(DEFAULT_ADMIN_ROLE)`. Перевірено через `V3WithDeviceRegistry.t.sol` (9 інтеграційних тестів — happy path, lifecycle, multi-device independence).

---

## 9. L-006: P256Verifier wrapper

**Призначення:** verify secp256r1 (P-256) signatures від ATECC608B чіпа.

**Context:** EVM не має precompile для P-256. EIP-7212/RIP-7212 у proposal stage, deployed тільки на Polygon zkEVM (станом на травень 2026).

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

**Implementation options (рішення у Етапі 3, тиждень 11):**
- **Daimo P256Verifier** — gas ~330K, audited (Veridise), deployed на multiple chains
- **FCL (Fresh Crypto Library)** — gas ~300K, formally verified у Coq (Renaud Dubois)
- **RIP-7212 precompile** — якщо/коли deployed на target chain

**V3 storage:** `address public p256Verifier`.
**Setter:** `setP256Verifier(address)` — `onlyRole(DEFAULT_ADMIN_ROLE)`.
**Event:** `P256VerifierChanged(address indexed oldVerifier, address indexed newVerifier)`.

---

## 10. HonkVerifier wrapper

**Призначення:** verify UltraHonk ZK proof, auto-generated від Aztec Barretenberg за Noir circuit.

**Context:** ZK circuit еволюціонує (v06 deployed, v07_spike experimental, v08 — target Етапу 3). Кожна version → нова HonkVerifier bytecode після `bb write_solidity_verifier`. Wrapper дозволяє swap без UUPS upgrade.

**Interface:**

```solidity
interface IHonkVerifier {
    function verify(
        bytes calldata proof,
        bytes32[] calldata publicInputs
    ) external view returns (bool);
}
```

**V3 storage:** `address public honkVerifier`.
**Setter:** `setHonkVerifier(address)` — `onlyRole(DEFAULT_ADMIN_ROLE)`.
**Event:** `HonkVerifierChanged(address indexed oldVerifier, address indexed newVerifier)`.

**Hash function в circuit:** Poseidon (BN254 parameters, see §3.1).

**Encoding від PublicInputs struct до bytes32[]:**

Реалізується у submitProof body (week 4). Псевдокод:

```solidity
function _encodePublicInputs(PublicInputs calldata pi)
    internal pure
    returns (bytes32[] memory)
{
    bytes32[] memory inputs = new bytes32[](9);
    inputs[0] = bytes32(uint256(pi.deviceId));
    inputs[1] = bytes32(uint256(pi.sessionId));
    inputs[2] = bytes32(uint256(pi.epochStartTs));
    inputs[3] = bytes32(uint256(int256(pi.lat_e7)));
    inputs[4] = bytes32(uint256(int256(pi.lon_e7)));
    inputs[5] = bytes32(uint256(pi.lightLevel));
    inputs[6] = bytes32(uint256(pi.tamperFlag));
    inputs[7] = pi.payloadHash;
    inputs[8] = bytes32(uint256(pi.totalEnergyMWh));
    return inputs;
}
```

Field order і encoding **MUST match** Noir circuit public output order. Verify alignment при v08 design.

---

## 11. submitProof flow (Architecture target + V3 gap-checking)

**Function signature:**

```solidity
function submitProof(
    PublicInputs calldata pubInputs,
    bytes32 payloadHash,
    bytes calldata signature,     // 64 bytes P-256 (r || s)
    bytes calldata devicePubkey,  // 64 bytes uncompressed (X || Y)
    bytes calldata proof          // ~440 bytes UltraHonk
) external whenNotPaused nonReentrant onlyRole(OPERATOR_ROLE);
```

**PublicInputs struct:**

```solidity
struct PublicInputs {
    uint64 deviceId;
    uint64 sessionId;
    uint64 epochStartTs;
    int64 lat_e7;
    int64 lon_e7;
    uint64 lightLevel;
    uint64 tamperFlag;
    bytes32 payloadHash;
    uint64 totalEnergyMWh;
}
```

**Семь перевірок у body:**

1. **Device authorized** — `IDeviceRegistry(deviceRegistry).isAuthorized(devicePubkey)`. Revert `DeviceNotActive` якщо ні.
2. **P-256 signature valid** — `IP256Verifier(p256Verifier).verify(payloadHash, r, s, pubKeyX, pubKeyY)`. Revert `InvalidP256Signature` якщо ні.
3. **Hash consistency** — `pubInputs.payloadHash == payloadHash`. Revert `PayloadHashMismatch(expected, fromPubInputs)` якщо ні.
4. **ZK proof valid** — `IHonkVerifier(honkVerifier).verify(proof, _encodePublicInputs(pubInputs))`. Revert `InvalidZKProof` якщо ні.
5. **Session unique** — `sessionKey = keccak256(pubInputs.deviceId, pubInputs.sessionId); require(!usedSessionKeys[sessionKey])`. Revert `SessionKeyAlreadyUsed(sessionKey)`.
6. **Epoch sanity** — `pubInputs.epochStartTs <= block.timestamp + 300`. Revert `EpochInFuture(epochTs, blockTs)`. (5-минутний tolerance для GPS/system drift.)
7. **Gap-checking + state update** — per §7 algorithm. Update `lastSubmissionTimestamp[deviceId]`, set `usedSessionKeys[sessionKey] = true`. Emit `ProofSubmitted(deviceId, sessionKey, timestamp, gap, postDisconnection)`.

**Order of checks** — від найдешевшого до найдорожчого (gas optimization для early revert):
1. Cheap state checks (sessions, timestamps, hash consistency) — first
2. External view call to DeviceRegistry — ~3K
3. P256 signature verify — ~300-400K
4. ZK proof verify — ~200-300K (most expensive, last)

**Trustless guarantee:** aggregator може лагати, бути compromised, втратити state — proof не пройде якщо хоч одна з 7 перевірок зламана.

---

## 12. Storage layout (UUPS critical)

V3 inherits multiple OZ upgradeable contracts. Користувацький storage йде після inherited.

**Layout:**

```
// Inherited slots (managed by OZ — DO NOT TOUCH ORDER):
//   Initializable, ContextUpgradeable, AccessControlUpgradeable._roles,
//   PausableUpgradeable._paused, ReentrancyGuardUpgradeable._status, UUPSUpgradeable

// V3 own slots (order matters for upgrades):
address public deviceRegistry;
address public p256Verifier;
address public honkVerifier;                                                // <-- added in v0.2
mapping(bytes32 deviceId => uint64) public lastSubmissionTimestamp;
mapping(bytes32 sessionKey => bool) public usedSessionKeys;

// Reserved gap for future versions:
uint256[49] private __gap;                                                  // <-- was [50] in v0.1
```

**`__gap[49]` convention:**
- 49 reserved slots = до 49 нових storage variables у V4, V5 без layout shifts
- При додаванні нової variable у V4 — декрементуй gap (e.g., `uint256[48] __gap`)

**CRITICAL:**
- НЕ змінювати порядок змінних у наступних версіях ПІСЛЯ deployment
- НЕ видаляти змінні (deprecated → залишити, не reuse slot)
- Нові змінні — ТІЛЬКИ В КІНЕЦЬ, перед `__gap`

**Pre-deployment changes (як зробили у v0.2):** safe — нікого не зачіпає бо нічого ще не deployed.

---

## 13. Events

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

event HonkVerifierChanged(
    address indexed oldVerifier,
    address indexed newVerifier
);

// Inherited:
//   AccessControl: RoleGranted, RoleRevoked, RoleAdminChanged
//   Pausable:      Paused, Unpaused
//   UUPS:          Upgraded
```

---

## 14. Custom errors

**V3-specific:**

```solidity
error DeviceNotActive(bytes32 deviceId);
error InvalidTimestamp(uint64 provided, uint64 lastKnown);
error SessionKeyAlreadyUsed(bytes32 sessionKey);
error InvalidP256Signature();
error InvalidZKProof();
error PayloadHashMismatch(bytes32 expected, bytes32 fromPubInputs);    // added v0.2
error EpochInFuture(uint64 epochTs, uint64 blockTs);                   // added v0.2
error ZeroAddress();
error SameAddress();
error NotImplemented();   // tymchasowo, для skeleton stubs
```

**Inherited (OZ v5):** `AccessControlUnauthorizedAccount`, `EnforcedPause`, `ReentrancyGuardReentrantCall`.

---

## 15. Gas estimation (revised — based on measured skeleton)

**Skeleton baseline measured:**
- v0.1 skeleton: **5,108 B** runtime
- v0.2 patch (HonkVerifier wrapper added): **5,748 B** runtime
- Delta from HonkVerifier integration: **+640 B**

**Projected with submit body:**

| Component | Est. B added |
|---|---|
| 7 checks logic (revert paths) | +500-800 |
| `_encodePublicInputs` helper | +200-300 |
| Gap-checking math + state updates | +300-500 |
| Event emit | +50 |
| Custom error data | +100-200 |
| **Total projected V3 runtime** | **7,000 – 8,500 B** |

**Margin to 24 KB EVM ceiling:** ~16,000 B (~67% headroom).

**Revises v0.1 estimate of 21-23 KB downward by 2-3x.** Original estimate was conservative without measuring. Bytecode growth risk (10.2 у v1.3 Plan) — **fact effectively no longer concerns us.**

**submitProof gas cost estimation:**

| Component | Gas |
|---|---|
| AccessControl + Pausable + Reentrancy | ~7K |
| `DeviceRegistry.isAuthorized` external view | ~3K |
| `P256Verifier.verify` | ~300-400K |
| `HonkVerifier.verify` | ~200-300K |
| `usedSessionKeys` SLOAD+SSTORE | ~22K |
| `lastSubmissionTimestamp` SLOAD+SSTORE | ~7K |
| Gap math + comparison | ~1K |
| Event emit | ~3K |
| **Rough total** | **~550K – 750K gas** |

**Implications:**
- Arbitrum @ 0.1 gwei → ~$0.10/submission. Viable.
- L1 mainnet → infeasible для high-volume. Arbitrum-first рішення з Plan v1.3 confirmed.

---

## 16. Foundry test plan

Test contracts:

```
test/V3_AccessControl.t.sol           (L-001) ⏳ Taras
test/V3_Pausable.t.sol                (L-002) ⏳ Taras
test/V3_ReentrancyGuard.t.sol         (L-003) ⏳ Taras
test/V3_GapChecking.t.sol             (L-004) ⏳ Taras
test/V3WithDeviceRegistry.t.sol       (L-005 integration, 9 tests) ✅ written 2026-05-13
test/V3_P256VerifierIntegration.t.sol    (L-006) ⏳ Taras
test/V3_HonkVerifierIntegration.t.sol    (HonkVerifier wrapper) ⏳ Taras
test/V3_Integration.t.sol             (end-to-end with mocks) ⏳ Taras
test/DeviceRegistry.t.sol             (standalone, 24 tests) ✅ written 2026-05-13
test/mocks/MockHonkVerifier.sol       (controllable verifier) ✅
test/mocks/MockP256Verifier.sol       (controllable verifier) ✅
test/mocks/MockDeviceRegistry.sol     (controllable registry — kept for Taras L-005 mock-only V3 tests) ✅
test/mocks/MaliciousVerifier.sol      (reentrancy attacker) ⏳ Taras
```

**Per-limitation scenarios** (детальний test plan як specification для Тараса):

**L-001 AccessControl:**
- happyPath, unauthorizedRevert, revokeRole, adminTransfer, pauserCannotUnpause

**L-002 Pausable:**
- pauseBlocksSubmit, unpauseRestores, nonPauserCannotPause, nonAdminCannotUnpause

**L-003 ReentrancyGuard:**
- maliciousVerifier (P256), maliciousRegistry, maliciousHonkVerifier

**L-004 Gap-checking:**
- firstSubmission, gapUnderMax, gapExactlyMax (boundary), gapJustOver, gapMuchOver
- timestampInPast → revert, timestampEqual → revert
- multipleDevices independent tracking
- eventFields match calculation

**L-005 DeviceRegistry:**
- authorizedDeviceSubmits, unauthorizedDeviceReverts (deactivated, never registered)
- swapRegistry, swapToZeroReverts

**L-006 P256Verifier:**
- validSignature, invalidSignature, swapVerifier, swapToZeroReverts

**HonkVerifier wrapper:**
- validProof (mock returns true), invalidProof (mock returns false)
- swapVerifier, swapToZeroReverts

**Integration:**
- fullFlow — register device → submit proof → second submit with gap → events correct
- 7-check order — each fails individually with correct error, no early return on wrong check
- pauseInterleave — pause mid-flow → subsequent submit blocks

**Coverage target:** >90% lines, >90% branches (per v1.3 §7.2).

---

## 17. Echidna invariants preview (for тиждень 7)

```
invariant_submitCounterMonotonic:
  ProofSubmitted events для deviceId — non-decreasing у часі

invariant_pausedMeansNoSubmit:
  paused() == true → жоден ProofSubmitted event у тому ж блоці

invariant_sessionKeyUnique:
  for any sessionKey, максимум один ProofSubmitted event

invariant_postDisconnectionMatchesGap:
  ProofSubmitted.gapFromPrevious > MAX_GAP_SECONDS → postDisconnection == true

invariant_nonOperatorCannotSubmit:
  msg.sender без OPERATOR_ROLE → submitProof revert-ує завжди

invariant_timestampMonotonicPerDevice:
  для deviceId — ProofSubmitted.timestamp strictly increasing

invariant_pubInputsHashConsistency:
  emitted ProofSubmitted має pubInputs.payloadHash == submitted payloadHash
```

24-годинний прогон у тижні 7 per v1.3 plan.

---

## 18. Відкриті питання для Олександрового review

**Closed since v0.1:**

- **Q6 (HonkVerifier hardcode vs wrapper)** — **CLOSED.** Wrapper pattern, mirror P256Verifier. Implemented у v0.2 skeleton.

**Closed since v0.2:**

- **Q4 (DeviceRegistry upgradeable vs non-upgradeable)** — **CLOSED.** Non-upgradeable (default). Implementation на `contracts/src/DeviceRegistry.sol` без UUPSUpgradeable inheritance. Якщо знадобиться fix bug — swap через `V3.setDeviceRegistry(newAddress)`, painful але manageable (всі devices re-registered через `OPERATOR_ROLE`).

**Still open для Олександрового review (handoff doc: `docs/handoffs/2026-05-13-oleksandr-v3-review.md`):**

**Q1. `MAX_GAP_SECONDS` — constant чи storage?**
- Constant: економить gas, без admin tuning
- Storage: дозволяє tuning (зимовий період, регіональні відмінності)
- **Current default:** constant. Якщо знадобиться change — UUPS upgrade.

**Q2. `setP256Verifier` / `setHonkVerifier` — timelock?**
- Adversary з compromised DEFAULT_ADMIN_ROLE може swap-нути на malicious verifier і затверджувати fake submissions
- 48h timelock у V3 → reaction window
- Альтернатива: external Timelock у Етапі 8 multisig pattern
- **Current default:** немає timelock у V3. Чекаємо Етап 8 для commits через Timelock Controller.

**Q3. `__gap[49]` — sufficient?**
- 49 slots = до 49 нових storage variables у V4-V5
- Чи передбачаємо V4 з >49 новими полями? Якщо так — збільшити.
- **Current default:** 49, OZ-recommended.

**Q5. `isAuthorized` перевірка — on-chain чи aggregator?**
- **Current default:** on-chain (V3 викликає DeviceRegistry.isAuthorized). +3K gas, defense-in-depth.

**Q7. `usedSessionKeys` storage growth cap?**
- Mapping ніколи не очищається (replay protection)
- На scale 10K submissions/year × 20K gas SSTORE ≈ $2K/year submit cost
- **Current default:** без TTL cap. Growth manageable.

**Closed during testing (Тарас, 2026-05-13):**

- **Q8 (L-003 Reentrancy: actual revert path)** — **CLOSED.** Всі external verifier interfaces (`IDeviceRegistry`, `IP256Verifier`, `IHonkVerifier`) declare consumed methods як `view`; Solidity emits `STATICCALL` що забороняє state-changing operations включаючи SSTORE при re-entry. Malicious verifier намагаючись re-enter `submitProof()` reverts at first SSTORE, не через `ReentrancyGuardReentrantCall`. Test file `V3_ReentrancyGuard.t.sol` використовує `vm.expectRevert()` без selector. `nonReentrant` modifier remains як defense-in-depth для future non-view verifier interfaces.

- **Q9 (Line coverage 86.67% vs 90% handoff target)** — **CLOSED.** Tool limitation, не test gap. Branch coverage 100% (20/20), function coverage 100% (10/10), statement coverage 87.10%. 12 рядків reported як not covered — все coverage tooling artifacts: line 118 (`_disableInitializers()` у constructor — `--ir-minimum` source-mapping artifact), lines 133-136 (`__AccessControl_init`/`__Pausable_init` macro expansions not tracked), lines 228-231 (assembly blocks not tracked by Foundry coverage).

---

## 19. Out of scope для V3 design (deferred)

| Item | Тиждень | Чому не зараз |
|---|---|---|
| EIP-712 typed signing | 5 | Polish, не core security |
| Per-device rate limit on-chain | 5 | Зараз rate limit у aggregator достатньо |
| Echidna invariant testing setup | 7 | Preview у §17, повна setup пізніше |
| OZ v5.0.2 → v5.2.0 для ReentrancyGuardTransient | Pre-mainnet (Phase 11) | $1-2K/year gas saving не varta swap на менш battle-tested код під час dev |

---

## 20. Status of next steps

1. ✅ V3 design v0.1 committed (a84166b, 2026-05-12)
2. ✅ OZ-upgradeable v5.0.2 dependency installed (53df18d, 2026-05-12)
3. ✅ V3 skeleton committed (53df18d, 2026-05-12)
4. ✅ V3 patch — HonkVerifier wrapper + PublicInputs struct (09652b9, 2026-05-12)
5. ✅ V3 design v0.2 (4ac735d, 2026-05-12)
6. ✅ submitProof body implementation з 7 verification checks (2d64198, 2026-05-12)
7. ✅ Test mocks MockHonkVerifier/MockP256Verifier/MockDeviceRegistry (ed5ec0d, 2026-05-12)
8. ✅ Taras handoff doc — V3 Foundry tests brief (e198bae, 2026-05-12)
9. ✅ Oleksandr handoff doc — §18 review questions Q1-Q5, Q7 (9caa219, 2026-05-13)
10. ✅ DeviceRegistry contract + 24 unit tests (8dd189b, 2026-05-13)
11. ✅ Test setUp fix — vm.prank gotcha (2e09d40, 2026-05-13)
12. ✅ CI workflow fix — continue-on-error removed (67e3c14, 2026-05-13)
13. ✅ V3 + DeviceRegistry integration tests, 9 tests (1f575a6, 2026-05-13)
14. ✅ Deployment scripts + .env.example + docs/deployment.md, локально перевірено end-to-end через anvil (6570aac, 2026-05-13)
15. ✅ V3 design v0.3 — this document
16. ⏳ Taras Foundry unit tests for V3 (L-001..L-006 + MaliciousVerifier) — у роботі
17. ⏳ Oleksandr async review §18 open questions Q1, Q2, Q3, Q5, Q7 (Q4 closed); blocked by his diploma
18. ⏳ Slither config update для аналізу `EnergyProofRegistryV3.sol` і `DeviceRegistry.sol` замість legacy v2 — окрема задача
19. ⏳ Sepolia розгортання — операційний крок, потребує реальний P-256 верифікатор (Daimo address у Sepolia), ETH у гаманці деплоєра, Etherscan API ключ. Наступна сесія.
20. ⏳ Передача DEFAULT_ADMIN_ROLE на Gnosis Safe мультипідпис — pre-mainnet (Етап 8)

---

## 21. Deployment

**Scripts (`contracts/script/`):**

- `Deploy.s.sol` — основний сценарій для Sepolia і мейннет. Деплоєр стає initial DEFAULT_ADMIN_ROLE на обох контрактах. Вимагає env: `PRIVATE_KEY`, `OPERATOR_ADDRESS`, `P256_VERIFIER_ADDRESS`, `HONK_VERIFIER_ADDRESS`. Опціонально реєструє один тестовий пристрій через `TEST_DEVICE_PUBKEY`.
- `DeployLocal.s.sol` — локальне розгортання у anvil з заглушками верифікаторів. Використовує anvil default accounts якщо env не встановлені. Дозволяє full end-to-end тестування без зовнішніх залежностей.
- `DeployDeviceRegistry.s.sol` — вузький сценарій для розгортання тільки DeviceRegistry (коли V3 вже розгорнутий і треба замінити registry).

**Документація:** `docs/deployment.md` — інструкції для anvil і Sepolia, контрольний список після розгортання, процедура передачі адмінства на мультипідпис.

**Локальне підтвердження (2026-05-13 через anvil):**

| Контракт | Адреса (anvil) |
| --- | --- |
| DeviceRegistry | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| V3 implementation | `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9` |
| V3 proxy | `0x5FC8d32690cc91D4c39d9d3abcBD16989F875707` |
| P256 mock | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| Honk mock | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |

Всі транзакції успішні, адмін отримав DEFAULT_ADMIN_ROLE на обох контрактах, оператор отримав OPERATOR_ROLE на обох.

**Pending (наступна сесія):** реальне розгортання у Sepolia. Залежності з пунктів 18, 19 з §20.

---

**Кінець V3 design v0.3.**
