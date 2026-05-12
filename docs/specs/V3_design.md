# V3 Design — EnergyProofRegistryV3

**Статус:** Draft v0.2
**Дата:** 2026-05-12
**Автор:** Petro Sydliarchuk
**Reviewers:** Oleksandr (security review), Taras (test plan)
**Stage:** MVP Plan v1.4 — Етап 2 (тижні 3-7)
**Closes:** L-001 … L-006 з `docs/specs/v2_known_limitations.md`

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
test/V3_AccessControl.t.sol           (L-001)
test/V3_Pausable.t.sol                (L-002)
test/V3_ReentrancyGuard.t.sol         (L-003)
test/V3_GapChecking.t.sol             (L-004)
test/V3_DeviceRegistryIntegration.t.sol  (L-005)
test/V3_P256VerifierIntegration.t.sol    (L-006)
test/V3_HonkVerifierIntegration.t.sol    (HonkVerifier wrapper, new)
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

**Q3. `__gap[49]` — sufficient?**
- 49 slots = до 49 нових storage variables у V4-V5
- Чи передбачаємо V4 з >49 новими полями? Якщо так — збільшити.
- **Current default:** 49, OZ-recommended.

**Q4. DeviceRegistry — upgradeable чи non-upgradeable?**
- **Current default:** non-upgradeable. Якщо bug — `setDeviceRegistry(newAddress)` у V3, але втрачаємо state.
- Альтернатива: DeviceRegistry як UUPS — fix bug без re-registration.

**Q5. `isAuthorized` перевірка — on-chain чи aggregator?**
- **Current default:** on-chain (V3 викликає DeviceRegistry.isAuthorized). +3K gas, defense-in-depth.

**Q7. `usedSessionKeys` storage growth cap?**
- Mapping ніколи не очищається (replay protection)
- На scale 10K submissions/year × 20K gas SSTORE ≈ $2K/year submit cost
- **Current default:** без TTL cap. Growth manageable.

---

## 19. Out of scope для V3 design (deferred)

| Item | Тиждень | Чому не зараз |
|---|---|---|
| EIP-712 typed signing | 5 | Polish, не core security |
| Per-device rate limit on-chain | 5 | Зараз rate limit у aggregator достатньо |
| UUPS proxy deployment scripts | 6 | Окрема робота, не у scope design |
| Echidna invariant testing setup | 7 | Preview у §17, повна setup пізніше |
| OZ v5.0.2 → v5.2.0 для ReentrancyGuardTransient | Pre-mainnet (Phase 11) | $1-2K/year gas saving не varta swap на менш battle-tested код під час dev |

---

## 20. Status of next steps

1. ✅ V3 design v0.1 committed (a84166b)
2. ✅ OZ-upgradeable v5.0.2 dependency installed (53df18d)
3. ✅ V3 skeleton committed (53df18d)
4. ✅ V3 patch — HonkVerifier wrapper + PublicInputs struct (09652b9)
5. ✅ V3 design v0.2 — this document
6. ⏳ submitProof body implementation (week 4 work, ~1.5-2 hours)
7. ⏳ MockHonkVerifier, MockP256Verifier, MockDeviceRegistry for unit tests
8. ⏳ Foundry tests per §16 plan (Тарас, паралельно)
9. ⏳ Олександр review of §18 open questions Q1-Q5, Q7 (async)

---

**Кінець V3 design v0.2.**
