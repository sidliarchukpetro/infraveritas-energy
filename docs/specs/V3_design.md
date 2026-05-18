# V3 Design — EnergyProofRegistryV3

**Статус:** Draft v0.3
**Дата:** 2026-05-17
**Автор:** Petro Sydliarchuk
**Reviewers:** Oleksandr (security review), Taras (test plan)
**Stage:** MVP Plan v1.4 — Етап 2 (тижні 3-7)
**Closes:** L-001 … L-006 з `docs/specs/v2_known_limitations.md`

---

## Changelog v0.2 → v0.3

- **EIP-712 typed signing layer implemented** — submitProof тепер verifies P-256 signature над EIP-712 digest замість сирого payloadHash. Захист від cross-chain, cross-contract і cross-function replay
  - Нові константи: `EIP712_DOMAIN_TYPEHASH`, `ENERGY_PROOF_TYPEHASH`, `DOMAIN_NAME_HASH`, `DOMAIN_VERSION_HASH`
  - Domain: `name="InfraVeritas Energy"`, `version="1"` (стабільні через апгрейди)
  - Storage: `__gap[49]` → `__gap[47]`, додано `_cachedDomainSeparator` + `_cachedChainId` (upgrade-safe декремент)
  - Нова admin функція: `reinitializeEIP712()` з `reinitializer(2)` для існуючих proxy після upgradeTo()
  - Нові public view: `domainSeparator()`, `eip712Digest(PublicInputs)` — для off-chain cross-check
  - Lazy rebuild domain separator при зміні chainId (chain fork protection)
- **CHECK 2 у submitProof оновлено:** тепер `IP256Verifier.verify(_eip712Digest(pubInputs), r, s, pubKeyX, pubKeyY)` замість `verify(payloadHash, ...)`. Підпис тепер над структурованим digest, не сирим хешем
- **Новий event:** `DomainSeparatorCached(uint256 indexed chainId, bytes32 domainSeparator)` — emit на initialize і reinitializeEIP712
- **Test suite extended** — новий `contracts/test/V3_EIP712.t.sol` (246 рядків, 12 тестів)
  - Domain separator computation + chain fork lazy rebuild
  - EIP-712 digest binding до chainId і verifyingContract (replay protection)
  - Reinitializer idempotency + access control
  - Event emission `DomainSeparatorCached`
  - Regression — happy path submitProof все ще працює через mock layer
- **Regression confirmed clean:**
  - forge test: 114/114 pass (102 existing + 12 new)
  - Slither: 0 findings (94 detectors, 23 contracts)
  - Echidna smoke 10K: 5/5 invariants passing, 6429 unique instructions
  - Foundry invariant #4, #7: 256K calls, 0 violations
- **§1 і §19 Deferred items закрито:** EIP-712 typed signing (тиждень 5), Echidna invariant testing (тиждень 7)
- **Sepolia deployment не виконано у цьому commit** — потребує синхронізованого update `edge/hal/signing.py` + `sepolia_smoke.py` перед `upgradeTo()` на існуючий proxy `0xf21d900e43214b0abf489f8d6862352aabb09da3`

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
- EIP-712 typed signing layer (додано у v0.3)

**Deferred у наступні тижні Етапу 2:**
- Per-device rate limit on-chain (тиждень 5)
- UUPS proxy concrete setup і tests (тиждень 6)

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
- `P256Verifier.verify(eip712Digest, signature, devicePubkey)` — view, ~300-400K gas (Daimo або FCL). v0.3: signature now over EIP-712 typed digest, не raw payloadHash.
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

### 3.4 EIP-712 typed signing layer (added 2026-05-17, v0.3)

**Decision:** P-256 підпис у submitProof тепер verifies над **EIP-712 typed digest** (per EIP-712 standard), не над сирим `payloadHash`.

**Why:**
- Сирий `payloadHash` сам по собі не binds підпис до конкретної мережі або контракту
- Зловмисник зі скопійованим signature може повторно подати proof на іншому ланцюгу або у V4/інший контракт з тим самим API
- EIP-712 digest binds підпис до `(chainId, verifyingContract, structured struct fields)` → block cross-chain, cross-contract, cross-function replay
- Industry standard для structured signing у Web3

**EIP-712 EnergyProof struct type:**

```
EnergyProof(
    uint64 deviceId,
    uint64 sessionId,
    uint64 epochStartTs,
    int64 lat_e7,
    int64 lon_e7,
    uint64 lightLevel,
    uint64 tamperFlag,
    bytes32 payloadHash,
    uint64 totalEnergyMWh
)
```

Field order MUST match `PublicInputs` struct exactly. Зміна struct fields = regenerate `ENERGY_PROOF_TYPEHASH`.

**Domain:**
- `name = "InfraVeritas Energy"` (без `V3` суфіксу — стабільне через апгрейди)
- `version = "1"`
- `chainId` = `block.chainid` (binding to current chain)
- `verifyingContract` = `address(this)` (binding to this proxy address)

**Digest formula:**
```
domainSeparator = keccak256(abi.encode(
    EIP712_DOMAIN_TYPEHASH,
    keccak256("InfraVeritas Energy"),
    keccak256("1"),
    block.chainid,
    address(this)
))

structHash = keccak256(abi.encode(
    ENERGY_PROOF_TYPEHASH,
    pi.deviceId, pi.sessionId, pi.epochStartTs,
    pi.lat_e7, pi.lon_e7,
    pi.lightLevel, pi.tamperFlag,
    pi.payloadHash, pi.totalEnergyMWh
))

digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash))
```

**Upgrade safety:**
- Storage `__gap[49]` → `__gap[47]`: 2 нові слоти (`_cachedDomainSeparator`, `_cachedChainId`)
- `initialize()` caches domain separator на свіжому deploy
- `reinitializeEIP712()` з `reinitializer(2)` — для існуючих proxy після `upgradeTo()`. Без виклику цієї функції контракт продовжує працювати (`domainSeparator()` lazy-rebuilds), але платить rebuild gas на кожен виклик
- При зміні `block.chainid` (chain fork) `domainSeparator()` lazy-rebuild на read

**Off-chain implications:**
- Edge firmware (`edge/hal/signing.py`) MUST sign `_eip712Digest(pubInputs)`, не `payloadHash`
- Edge мусить знати всі 9 полів `PublicInputs`, включно з `totalEnergyMWh`, перш ніж підписувати
- Aggregator може re-compute digest для cross-validation through `eip712Digest()` view function

**Cross-chain replay protection example:**
- Sepolia chainId = 11155111 → digest_sepolia
- Mainnet chainId = 1 → digest_mainnet
- digest_sepolia ≠ digest_mainnet навіть з ідентичним struct → підпис non-portable

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
| `reinitializeEIP712` | `DEFAULT_ADMIN_ROLE` (v0.3) |
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

Окремий контракт, **non-upgradeable у MVP** (рішення — §15 open question 4).

**Storage:**

```solidity
struct Device {
    bytes publicKey;     // 64 bytes — secp256r1 X || Y (P-256)
    address owner;
    uint64 registeredAt;
    bool isActive;
}

mapping(bytes32 pubkeyHash => Device) private devices;  // key: keccak256(publicKey)
```

**Ролі:**
- `DEFAULT_ADMIN_ROLE` — root
- `REGISTRAR_ROLE` — додає, деактивує, реактивує devices

**Interface (per Architecture.docx pattern — pubkey-based identity):**

```solidity
interface IDeviceRegistry {
    function isAuthorized(bytes calldata publicKey) external view returns (bool);
    function getDevice(bytes calldata publicKey) external view returns (Device memory);
}
```

**Why pubkey-based, not deviceId-based:**
- Одна перевірка `isAuthorized(pubkey)` замість двох (`isActive(id)` + `getPublicKey(id)`)
- Pubkey і так у параметрах submitProof для P256 verify — не дублюємо лookup
- Pubkey є криптографічним identity, deviceId просто human-readable counter у pubInputs

`deviceId` (з PublicInputs) використовується для **event indexing** і **gap-checking** lookup. `devicePubkey` — для verification.

**Mutators:**
- `registerDevice(bytes publicKey, address owner)` — `onlyRole(REGISTRAR_ROLE)`
- `deactivateDevice(bytes publicKey)` — `onlyRole(REGISTRAR_ROLE)`
- `reactivateDevice(bytes publicKey)` — `onlyRole(REGISTRAR_ROLE)`

**Events:**
- `DeviceRegistered(bytes indexed publicKey, address indexed owner, uint64 timestamp)`
- `DeviceDeactivated(bytes indexed publicKey, uint64 timestamp)`
- `DeviceReactivated(bytes indexed publicKey, uint64 timestamp)`

**Integration з V3:**

```solidity
if (!IDeviceRegistry(deviceRegistry).isAuthorized(devicePubkey)) {
    revert DeviceNotActive(bytes32(keccak256(devicePubkey)));
}
```

V3 may swap registry: `setDeviceRegistry(address)` — `onlyRole(DEFAULT_ADMIN_ROLE)`.

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

**v0.3 note:** `messageHash` argument тепер EIP-712 digest, не сирий Poseidon `payloadHash`. P256Verifier interface не змінюється — він hash-agnostic, тільки verifies signature над provided 32-byte hash.

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

## 11. submitProof flow (Architecture target + V3 gap-checking + EIP-712 v0.3)

**Function signature:**

```solidity
function submitProof(
    PublicInputs calldata pubInputs,
    bytes32 payloadHash,
    bytes calldata signature,     // 64 bytes P-256 (r || s) над EIP-712 digest (v0.3)
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
2. **P-256 signature valid (EIP-712 typed, v0.3)** — `IP256Verifier(p256Verifier).verify(_eip712Digest(pubInputs), r, s, pubKeyX, pubKeyY)`. Підпис тепер над структурованим EIP-712 digest який binds (chainId, verifyingContract, struct fields), не над сирим payloadHash. Revert `InvalidP256Signature` якщо ні.
3. **Hash consistency** — `pubInputs.payloadHash == payloadHash`. Revert `PayloadHashMismatch(expected, fromPubInputs)` якщо ні.
4. **ZK proof valid** — `IHonkVerifier(honkVerifier).verify(proof, _encodePublicInputs(pubInputs))`. Revert `InvalidZKProof` якщо ні.
5. **Session unique** — `sessionKey = keccak256(pubInputs.deviceId, pubInputs.sessionId); require(!usedSessionKeys[sessionKey])`. Revert `SessionKeyAlreadyUsed(sessionKey)`.
6. **Epoch sanity** — `pubInputs.epochStartTs <= block.timestamp + 300`. Revert `EpochInFuture(epochTs, blockTs)`. (5-минутний tolerance для GPS/system drift.)
7. **Gap-checking + state update** — per §7 algorithm. Update `lastSubmissionTimestamp[deviceId]`, set `usedSessionKeys[sessionKey] = true`. Emit `ProofSubmitted(deviceId, sessionKey, timestamp, gap, postDisconnection)`.

**Order of checks** — від найдешевшого до найдорожчого (gas optimization для early revert):
1. Cheap state checks (sessions, timestamps, hash consistency) — first
2. External view call to DeviceRegistry — ~3K
3. P256 signature verify (over EIP-712 digest) — ~300-400K
4. ZK proof verify — ~200-300K (most expensive, last)

**Trustless guarantee:** aggregator може лагати, бути compromised, втратити state — proof не пройде якщо хоч одна з 7 перевірок зламана. v0.3 додає cross-chain і cross-contract replay protection через EIP-712 typed signing.

---

## 12. Storage layout (UUPS critical)

V3 inherits multiple OZ upgradeable contracts. Користувацький storage йде після inherited.

**Layout (v0.3):**

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
bytes32 private _cachedDomainSeparator;                                     // <-- added in v0.3
uint256 private _cachedChainId;                                             // <-- added in v0.3

// Reserved gap for future versions:
uint256[47] private __gap;                                                  // <-- was [49] in v0.2, [50] in v0.1
```

**`__gap[47]` convention:**
- 47 reserved slots = до 47 нових storage variables у V4, V5 без layout shifts
- При додаванні нової variable у V4 — декрементуй gap (e.g., `uint256[46] __gap`)

**CRITICAL:**
- НЕ змінювати порядок змінних у наступних версіях ПІСЛЯ deployment
- НЕ видаляти змінні (deprecated → залишити, не reuse slot)
- Нові змінні — ТІЛЬКИ В КІНЕЦЬ, перед `__gap`

**Pre-deployment changes (як зробили у v0.2):** safe — нікого не зачіпає бо нічого ще не deployed.

**v0.3 upgrade-safe декремент:** Два нові слоти беруться з кінця попереднього `__gap[49]`. Існуючі deployed proxy: storage layout preserved. `_cachedDomainSeparator` і `_cachedChainId` починаються як 0 на existing proxy після `upgradeTo()` — `domainSeparator()` lazy-rebuilds на read до тих пір поки не виконано `reinitializeEIP712()`.

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

event DomainSeparatorCached(                                                // <-- added in v0.3
    uint256 indexed chainId,
    bytes32 domainSeparator
);

// Inherited:
//   AccessControl: RoleGranted, RoleRevoked, RoleAdminChanged
//   Pausable:      Paused, Unpaused
//   UUPS:          Upgraded
//   Initializable: Initialized
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
error InvalidSignatureLength(uint256 length);
error InvalidPubkeyLength(uint256 length);
error ZeroAddress();
error SameAddress();
```

**Inherited (OZ v5):** `AccessControlUnauthorizedAccount`, `EnforcedPause`, `ReentrancyGuardReentrantCall`, `InvalidInitialization` (для повторного `reinitializeEIP712`).

**v0.3 note:** No new custom errors. `reinitializeEIP712` повторний виклик reverts через OZ `InvalidInitialization` з `Initializable`.

---

## 15. Gas estimation (revised — based on measured skeleton)

**Skeleton baseline measured:**
- v0.1 skeleton: **5,108 B** runtime
- v0.2 patch (HonkVerifier wrapper added): **5,748 B** runtime
- Delta from HonkVerifier integration: **+640 B**

**Projected with submit body + EIP-712 layer (v0.3):**

| Component | Est. B added |
|---|---|
| 7 checks logic (revert paths) | +500-800 |
| `_encodePublicInputs` helper | +200-300 |
| Gap-checking math + state updates | +300-500 |
| Event emit | +50 |
| Custom error data | +100-200 |
| EIP-712 layer (typehashes, helpers, reinit, cached domain) (v0.3) | +500-700 |
| **Total projected V3 runtime** | **7,500 – 9,200 B** |

**Margin to 24 KB EVM ceiling:** ~15,000 B (~62% headroom).

**Revises v0.1 estimate of 21-23 KB downward by 2-3x.** Original estimate was conservative without measuring. Bytecode growth risk (10.2 у v1.3 Plan) — **fact effectively no longer concerns us.**

**submitProof gas cost estimation:**

| Component | Gas |
|---|---|
| AccessControl + Pausable + Reentrancy | ~7K |
| `DeviceRegistry.isAuthorized` external view | ~3K |
| EIP-712 digest computation (cached domain) (v0.3) | ~3-5K |
| `P256Verifier.verify` over EIP-712 digest | ~300-400K |
| `HonkVerifier.verify` | ~200-300K |
| `usedSessionKeys` SLOAD+SSTORE | ~22K |
| `lastSubmissionTimestamp` SLOAD+SSTORE | ~7K |
| Gap math + comparison | ~1K |
| Event emit | ~3K |
| **Rough total** | **~550K – 750K gas** |

EIP-712 layer додає ~3-5K gas за один виклик (один extra keccak + кілька MLOAD з cached domain). Marginal impact.

**Implications:**
- Arbitrum @ 0.1 gwei → ~$0.10/submission. Viable.
- L1 mainnet → infeasible для high-volume. Arbitrum-first рішення з Plan v1.3 confirmed.

---

## 16. Foundry test plan

Test contracts:

```
test/V3_AccessControl.t.sol           (L-001)
test/V3_Pausable.t.sol                (L-002)
test/V3_ReentrancyGuard.t.sol         (L-003)
test/V3_GapChecking.t.sol             (L-004)
test/V3_DeviceRegistryIntegration.t.sol  (L-005)
test/V3_P256VerifierIntegration.t.sol    (L-006)
test/V3_HonkVerifierIntegration.t.sol    (HonkVerifier wrapper, new)
test/V3_EIP712.t.sol                  (EIP-712 typed signing layer, added v0.3)
test/V3_Integration.t.sol             (end-to-end, all together)
test/DeviceRegistry.t.sol             (standalone)
test/mocks/MockHonkVerifier.sol       (controllable verifier, always-true or selectable)
test/mocks/MockP256Verifier.sol       (controllable verifier)
test/mocks/MockDeviceRegistry.sol     (controllable registry)
test/mocks/MaliciousVerifier.sol      (reentrancy attacker)
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

**EIP-712 (v0.3):**
- domainSeparator correct compute, lazy rebuild on chainid change
- eip712Digest matches reference computation
- digest changes with chainid, contract address, struct fields
- reinitializeEIP712 callable once, then reverts (reinitializer pattern)
- reinitializeEIP712 admin-only
- DomainSeparatorCached event emission
- submitProof regression — mocks layer happy path still passes

**Integration:**
- fullFlow — register device → submit proof → second submit with gap → events correct
- 7-check order — each fails individually with correct error, no early return on wrong check
- pauseInterleave — pause mid-flow → subsequent submit blocks

**Coverage target:** >90% lines, >90% branches (per v1.3 §7.2).

---

## 17. Echidna invariants preview (для тиждень 7)

Echidna harness implemented and exercised under sprint pre-audit closure (2026-05-17). Active invariants:

```
echidna_counter_monotonic:
  per-device submit count тільки зростає (#1)

echidna_paused_blocks_submit:
  paused() → жоден successful submit (#2)

echidna_session_key_unique:
  кожен sessionKey максимум один accepted submit (#3)

echidna_non_operator_cannot_submit:
  callers без OPERATOR_ROLE завжди revert (#5)

echidna_timestamp_monotonic:
  per-device timestamps strictly increasing (#6)
```

Forge invariants (`test/V3_Invariants.t.sol`):

```
invariant_postDisconnectionMatchesGap:
  ProofSubmitted.gapFromPrevious > MAX_GAP_SECONDS → postDisconnection == true (#4)

invariant_payloadHashConsistency:
  emitted ProofSubmitted потребує pi.payloadHash == param.payloadHash (#7)
```

**Sprint results (2026-05-17):**
- 24h Echidna run: 100,000,174 transactions, всі 5 invariants passing, 0 violations
- Forge invariant: 256 runs × 500 depth × 2 invariants = 256K calls, 0 violations
- v0.3 EIP-712 layer додано — re-run 10K smoke confirms all 5 echidna invariants still passing з оновленим контрактом

---

## 18. Відкриті питання для Олександрового review

**Closed since v0.1:**

- **Q6 (HonkVerifier hardcode vs wrapper)** — **CLOSED.** Wrapper pattern, mirror P256Verifier. Implemented у v0.2 skeleton.

**Still open для Олександрового review:**

**Q1. `MAX_GAP_SECONDS` — constant чи storage?**
- Constant: економить gas, без admin tuning
- Storage: дозволяє tuning (зимовий період, регіональні відмінності)
- **Current default:** constant. Якщо знадобиться change — UUPS upgrade.

**Q2. `setP256Verifier` / `setHonkVerifier` — timelock?**
- Adversary з compromised DEFAULT_ADMIN_ROLE може swap-нути на malicious verifier і затверджувати fake submissions
- 48h timelock у V3 → reaction window
- Альтернатива: external Timelock у Етапі 8 multisig pattern
- **Current default:** немає timelock у V3. Чекаємо Етап 8 для commits через Timelock Controller.

**Q3. `__gap[47]` — sufficient?** (v0.3 — раніше було `__gap[49]`)
- 47 slots = до 47 нових storage variables у V4-V5
- Чи передбачаємо V4 з >47 новими полями? Якщо так — збільшити перед production
- **Current default:** 47, OZ-recommended

**Q4. DeviceRegistry — upgradeable чи non-upgradeable?**
- **Current default:** non-upgradeable. Якщо bug — `setDeviceRegistry(newAddress)` у V3, але втрачаємо state.
- Альтернатива: DeviceRegistry як UUPS — fix bug без re-registration.

**Q5. `isAuthorized` перевірка — on-chain чи aggregator?**
- **Current default:** on-chain (V3 викликає DeviceRegistry.isAuthorized). +3K gas, defense-in-depth.

**Q7. `usedSessionKeys` storage growth cap?**
- Mapping ніколи не очищається (replay protection)
- На scale 10K submissions/year × 20K gas SSTORE ≈ $2K/year submit cost
- **Current default:** без TTL cap. Growth manageable.

**Q10 (new v0.3). EIP-712 domain version policy.**
- Поточний `version = "1"`. Якщо у майбутньому struct shape EnergyProof зміниться (нові поля) — версію треба bump на `"2"`, інакше підпис v1 формально valid для v2 struct
- Stand-in рішення: документувати що зміна `PublicInputs` struct = bump `DOMAIN_VERSION_HASH` у constants + redeploy + reinitializeEIP712
- **Current default:** version "1" жорстко captured у constant. Зміна = code change + redeploy.

**Closed during testing (Тарас, 2026-05-13):**

- **Q8 (L-003 Reentrancy: actual revert path)** — **CLOSED.** Всі external verifier interfaces (`IDeviceRegistry`, `IP256Verifier`, `IHonkVerifier`) declare consumed methods як `view`; Solidity emits `STATICCALL` що забороняє state-changing operations включаючи SSTORE при re-entry. Malicious verifier намагаючись re-enter `submitProof()` reverts at first SSTORE, не через `ReentrancyGuardReentrantCall`. Test file `V3_ReentrancyGuard.t.sol` використовує `vm.expectRevert()` без selector. `nonReentrant` modifier remains як defense-in-depth для future non-view verifier interfaces.

- **Q9 (Line coverage 86.67% vs 90% handoff target)** — **CLOSED.** Tool limitation, не test gap. Branch coverage 100% (20/20), function coverage 100% (10/10), statement coverage 87.10%. 12 рядків reported як not covered — все coverage tooling artifacts: line 118 (`_disableInitializers()` у constructor — `--ir-minimum` source-mapping artifact), lines 133-136 (`__AccessControl_init`/`__Pausable_init` macro expansions not tracked), lines 228-231 (assembly blocks not tracked by Foundry coverage).

---

## 19. Out of scope для V3 design (deferred)

| Item | Тиждень | Чому не зараз |
|---|---|---|
| Per-device rate limit on-chain | 5 | Зараз rate limit у aggregator достатньо |
| UUPS proxy deployment scripts | 6 | Окрема робота, не у scope design |
| OZ v5.0.2 → v5.2.0 для ReentrancyGuardTransient | Pre-mainnet (Phase 11) | $1-2K/year gas saving не varta swap на менш battle-tested код під час dev |

**Items closed since v0.2:**
- ~~EIP-712 typed signing~~ → implemented у v0.3 (see §3.4)
- ~~Echidna invariant testing setup~~ → implemented у sprint pre-audit closure (see §17)

---

## 20. Status of next steps

1. ✅ V3 design v0.1 committed (a84166b)
2. ✅ OZ-upgradeable v5.0.2 dependency installed (53df18d)
3. ✅ V3 skeleton committed (53df18d)
4. ✅ V3 patch — HonkVerifier wrapper + PublicInputs struct (09652b9)
5. ✅ V3 design v0.2 committed
6. ✅ submitProof body implementation (Етап 2 тиждень 4)
7. ✅ Mocks + Foundry tests per §16 plan (Тарас)
8. ✅ V3 design v0.3 — this document (EIP-712 typed signing)
9. ⏳ Edge firmware (`edge/hal/signing.py`) + `sepolia_smoke.py` update для EIP-712 (наступний sprint)
10. ⏳ Sepolia proxy `upgradeTo()` + `reinitializeEIP712()` (після edge sync)
11. ⏳ Олександр review of §18 open questions Q1-Q5, Q7, Q10 (async)

---

**Кінець V3 design v0.3.**


### Q8 — L-003 Reentrancy: actual revert path (added 2026-05-12)

Status: Resolved by tests with adjusted expectations.

All external verifier interfaces (`IDeviceRegistry`, `IP256Verifier`, `IHonkVerifier`)
declare their consumed methods as `view`. Solidity emits `STATICCALL` for those.
EVM `STATICCALL` forbids state-changing operations in the called contract or any
nested call — so a malicious verifier attempting to re-enter `submitProof()` reverts
at the first SSTORE in the re-entry, not via `ReentrancyGuardReentrantCall`.

Test file `V3_ReentrancyGuard.t.sol` uses `vm.expectRevert()` without selector
(any revert is acceptable) and documents the rationale. `nonReentrant` modifier
remains as defense-in-depth for any future non-view verifier interface.


### Q9 — Line coverage 86.67% (resolved by tool limitation, 2026-05-12)

Status: Resolved. Line coverage cannot reach handoff target ≥90% due to a Foundry
toolchain limitation, not insufficient tests. Branch coverage achieves 100% (20/20).

Final metrics on src/EnergyProofRegistryV3.sol:
  - Branches:  100.00%  (20/20)   ✓ target ≥90%
  - Functions: 100.00%  (10/10)   ✓
  - Statements: 87.10%  (81/93)
  - Lines:      86.67%  (78/90)   ✗ target ≥90% — see below

12 lines reported as not covered are all artifacts of the coverage tooling:

| Line(s) | Code                                                | Reason                                          |
|---------|-----------------------------------------------------|-------------------------------------------------|
| 118     | _disableInitializers() in constructor               | --ir-minimum source-mapping artifact            |
| 133–136 | __AccessControl_init/__Pausable_init/etc            | Macro expansions not tracked by line counter    |
| 228–231 | assembly { r := calldataload(...) ... }             | Assembly blocks not tracked by Foundry coverage |
| 279     | return inputs; in _encodePublicInputs               | Source-mapping artifact (function called 32×)   |
| 287     | _pause(); body of pause()                           | Source-mapping artifact (called 7×)             |
| 291     | _unpause(); body of unpause()                       | Source-mapping artifact (called 4×)             |

All 12 lines DO execute — confirmed by FNDA function-hit counters in lcov output.
The constructor runs 47×, initialize() 50×+, pause() 7×, unpause() 4×, etc.

Root cause: forge coverage cannot run with viaIR optimizer enabled (the source maps
that Solidity emits in optimised mode are incomplete for coverage). Without viaIR,
the assembly block at line 227–232 triggers "Stack too deep". The --ir-minimum flag
enables viaIR with minimum optimization as a workaround, but Foundry explicitly
warns that source mappings under this mode can be inaccurate.

Mitigation: branches and functions both 100%. Every revert path and every
function entry is exercised. The 12 unreached lines are mechanical statements
inside otherwise-covered functions.

If a future requirement insists on literal ≥90% lines, options are:
  1. Switch to coverage-via-trace tooling (heavier, separate setup).
  2. Refactor the assembly block in submitProof to a pure-Solidity equivalent
     and rerun coverage without --ir-minimum (would also remove assembly artifact
     at lines 228–231). NOTE: this is a src/ change and outside Stage 2 scope.
