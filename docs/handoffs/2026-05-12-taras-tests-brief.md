# Завдання: Foundry tests для EnergyProofRegistryV3

**Для:** Тарас
**Від:** Петро (через handoff Claude)
**Дата:** 2026-05-12
**Етап:** 2 (тиждень 4-5), паралельно з продовженням roboты Петра/Олександра
**Estimate:** 8-12 годин зосередженої роботи

---

## 1. Контекст

**InfraVeritas Energy** — ZK-protocol для верифікації енерговироблення IoT edge-пристроями. EnergyProofRegistryV3 — head smart contract що приймає proofs від edge devices через aggregator (operator-only).

**V3 contract — implementation merged до main сьогодні:**
- UUPS upgradeable, наследує OZ AccessControl/Pausable/ReentrancyGuard
- Зовнішні залежності: DeviceRegistry, P256Verifier, HonkVerifier (всі через interfaces)
- Core function: `submitProof()` з **7 verification checks** (per design v0.2 §11)
- Bytecode: 6,784 B (74% headroom до 24 KB)
- Compile clean з viaIR pipeline

Repo: `https://github.com/sidliarchukpetro/infraveritas-energy` (private)
Branch: `main`
Working directory: `contracts/`

---

## 2. Завдання

Написати Foundry test suite для V3 contract, покриваючи **6 limitations + інтеграційний test**, per docs/specs/V3_design.md §16.

**Цільові метрики:**
- Coverage: ≥90% lines, ≥90% branches
- Всі CI checks green (compile, Slither, lint)
- Кожен test файл self-contained (можна запускати окремо)
- Зрозумілі test names (`test_<scenario>` convention)

**НЕ у твоєму скоупі:**
- Echidna invariant testing (deferred до тижня 7)
- Fuzz tests (можеш додати якщо є час, але not required)
- Gas optimization tests
- Тестування DeviceRegistry standalone (Етап 2 тижні 5-6, окрема задача)

---

## 3. Що вже зроблено (твоя starting point)

**Commits на main today (всі CI green):**
| Hash | Що |
|---|---|
| a84166b | V3 design v0.1 |
| 53df18d | OZ-upgradeable v5.0.2 + V3 skeleton |
| 09652b9 | V3 patch: HonkVerifier wrapper |
| 4ac735d | V3 design v0.2 (актуальний design doc) |
| 2d64198 | V3 submitProof body — 7 verification checks |
| ed5ec0d | **3 mock contracts у test/mocks/** ← твоя інфраструктура |

**Файли які тобі знадобляться:**
- `docs/specs/V3_design.md` — **актуальний design doc, §16 містить твій test plan**
- `contracts/src/EnergyProofRegistryV3.sol` — contract під тестом
- `contracts/src/interfaces/IDeviceRegistry.sol`, `IP256Verifier.sol`, `IHonkVerifier.sol`
- `contracts/test/mocks/MockHonkVerifier.sol` — controllable, `setShouldReturnTrue(bool)`
- `contracts/test/mocks/MockP256Verifier.sol` — controllable, `setShouldReturnTrue(bool)`
- `contracts/test/mocks/MockDeviceRegistry.sol` — stateful, `setAuthorized(pubkey, bool)`
- `contracts/foundry.toml` — компілятор config (Solc 0.8.28, viaIR, evm cancun)

---

## 4. Setup

```bash
# Clone (якщо ще нема локально)
git clone [email protected]:sidliarchukpetro/infraveritas-energy.git
cd infraveritas-energy/contracts

# Pull latest
git pull origin main

# Install Foundry якщо не маєш
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Submodules для OZ (вже у репо як lib/)
git submodule update --init --recursive

# Verify build
forge build --sizes
# Очікую: EnergyProofRegistryV3 6,784 B + 3 mocks + OZ contracts
```

Працюєш у branch `tests/<твоя-назва>` або прямо у main якщо ти швидкий. Domовляйся з Петром по branch strategy.

---

## 5. Test files — структура і scope

Створи файли у `contracts/test/`:

```
test/
├── mocks/                       # вже існує
│   ├── MockHonkVerifier.sol
│   ├── MockP256Verifier.sol
│   └── MockDeviceRegistry.sol
├── V3TestBase.sol              # NEW — abstract з spilnym setUp()
├── V3_AccessControl.t.sol      # L-001
├── V3_Pausable.t.sol           # L-002
├── V3_ReentrancyGuard.t.sol    # L-003
├── V3_GapChecking.t.sol        # L-004
├── V3_DeviceRegistry.t.sol     # L-005 integration
├── V3_P256Verifier.t.sol       # L-006 integration
├── V3_HonkVerifier.t.sol       # HonkVerifier wrapper integration
└── V3_Integration.t.sol        # end-to-end full flow
```

---

### 5.1 V3TestBase.sol (пиши спершу)

Abstract contract з common `setUp()` що:

1. Deploy 3 mocks (`new MockHonkVerifier()`, etc.)
2. Deploy V3 implementation: `EnergyProofRegistryV3 impl = new EnergyProofRegistryV3()`
3. Prepare init data: `abi.encodeCall(impl.initialize, (admin, mockDeviceRegistry, mockP256, mockHonk))`
4. Deploy proxy: `new ERC1967Proxy(address(impl), initData)` (import з `@openzeppelin/contracts/proxy/ERC1967/`)
5. Cast: `v3 = EnergyProofRegistryV3(address(proxy))`
6. Grant `OPERATOR_ROLE` до `operator` test address (`vm.prank(admin); v3.grantRole(...)`)
7. Optionally grant `PAUSER_ROLE` до іншого address
8. Set default authorized device у `mockDeviceRegistry` через `setAuthorized(testPubkey, true)`

**Експоновані state variables для child tests:**
```solidity
EnergyProofRegistryV3 internal v3;
MockHonkVerifier internal mockHonk;
MockP256Verifier internal mockP256;
MockDeviceRegistry internal mockRegistry;
address internal admin = makeAddr("admin");
address internal operator = makeAddr("operator");
address internal pauser = makeAddr("pauser");
bytes internal testPubkey = hex"04..." // 64 bytes uncompressed P-256
```

**Helper functions у TestBase:**
- `_buildValidPubInputs() returns (PublicInputs memory)` — стандартний валідний struct
- `_submitWithDefaults()` — викликає submitProof з валідними params
- `_setMocksHappyPath()` — всі mocks return true, device authorized

---

### 5.2 Test scenarios per L-00X

**Повний test plan — у `docs/specs/V3_design.md` §16.** Нижче — сумарій який ти переломуєш у concrete `test_xxx()` functions.

#### V3_AccessControl.t.sol (L-001)
- `test_OnlyOperatorCanSubmit()` — non-operator → revert AccessControlUnauthorizedAccount
- `test_OperatorCanSubmit()` — happy path
- `test_AdminCanGrantOperatorRole()` — admin grants OPERATOR_ROLE, новий operator може submit
- `test_AdminCanRevokeOperatorRole()` — revoke → submit reverts
- `test_PauserCannotUnpause()` — pauser викликає unpause → revert (asymmetric pattern)
- `test_NonAdminCannotChangeDeviceRegistry()` — setDeviceRegistry from non-admin → revert
- `test_NonUpgraderCannotUpgrade()` — _authorizeUpgrade gated by UPGRADER_ROLE

#### V3_Pausable.t.sol (L-002)
- `test_PauseBlocksSubmit()` — pauser pauses → submit reverts EnforcedPause
- `test_UnpauseRestoresSubmit()` — admin unpauses → submit works
- `test_NonPauserCannotPause()` — random caller → revert
- `test_NonAdminCannotUnpause()` — operator (not admin) tries unpause → revert
- `test_PausedDoesNotBlockViewFunctions()` — usedSessionKeys, lastSubmissionTimestamp still readable

#### V3_ReentrancyGuard.t.sol (L-003)
- Тут потрібно написати **MaliciousVerifier.sol** mock який пробує re-call submit з midstring verify call
- `test_ReentrantCallRevertsViaP256()` — malicious P256Verifier calls back submit → revert ReentrancyGuardReentrantCall
- `test_ReentrantCallRevertsViaHonkVerifier()` — similar through HonkVerifier
- (DeviceRegistry.isAuthorized теж зовнішній view, але повертає bool не може trigger-ить reentrancy без callback; можна skip)

#### V3_GapChecking.t.sol (L-004) ⚠ careful with edge cases
- `test_FirstSubmissionPostDisconnectionFalse()` — previousTimestamp=0, gap=0, flag=false
- `test_GapUnderMaxFlagFalse()` — gap = 47h, postDisconnection=false
- `test_GapExactlyMaxBoundaryFlagFalse()` — gap = 48h *exactly*, postDisconnection=false (`>` not `>=`)
- `test_GapJustOverMaxFlagTrue()` — gap = 48h + 1s, postDisconnection=true
- `test_GapMuchOverMaxFlagTrue()` — gap = 7 days, flag=true
- `test_TimestampInPastReverts()` — new < previous → revert InvalidTimestamp
- `test_TimestampEqualReverts()` — new == previous → revert InvalidTimestamp
- `test_MultipleDevicesIndependent()` — два devices, gaps tracked separately
- `test_EventFieldsMatchCalculation()` — emit ProofSubmitted має правильні gap, postDisconnection

#### V3_DeviceRegistry.t.sol (L-005)
- `test_AuthorizedDeviceSubmits()` — happy path
- `test_DeauthorizedDeviceReverts()` — `mockRegistry.setAuthorized(pubkey, false)` → submit reverts DeviceNotActive
- `test_NeverRegisteredDeviceReverts()` — pubkey ніколи не authorize-нутий → revert
- `test_SetDeviceRegistryByAdmin()` — admin swaps registry, новий activate-ить різні devices
- `test_SetDeviceRegistryToZeroReverts()` — revert ZeroAddress
- `test_SetDeviceRegistryToSameReverts()` — revert SameAddress

#### V3_P256Verifier.t.sol (L-006)
- `test_ValidSignatureAccepted()` — mock returns true
- `test_InvalidSignatureReverts()` — `mockP256.setShouldReturnTrue(false)` → revert InvalidP256Signature
- `test_SetP256VerifierByAdmin()` — swap mock, новий приймає різні signatures
- `test_SetP256VerifierToZeroReverts()`
- `test_InvalidSignatureLengthReverts()` — pass 63-byte signature → revert InvalidSignatureLength
- `test_InvalidPubkeyLengthReverts()` — pass 63-byte pubkey → revert InvalidPubkeyLength

#### V3_HonkVerifier.t.sol (HonkVerifier wrapper)
- `test_ValidProofAccepted()` — mockHonk.shouldReturnTrue = true
- `test_InvalidProofReverts()` — mockHonk.shouldReturnTrue = false → revert InvalidZKProof
- `test_SetHonkVerifierByAdmin()` — swap, новий валідатор
- `test_SetHonkVerifierToZeroReverts()`
- `test_SetHonkVerifierEventEmitted()` — HonkVerifierChanged event з правильними old/new

#### V3_Integration.t.sol (end-to-end)
- `test_FullFlow()` — register device → submit valid proof → check event emitted → submit second proof with valid gap → check timestamps updated
- `test_7CheckOrderEachFailsIndependently()` — для кожної з 7 перевірок зробити ситуацію де ТІЛЬКИ та перевірка fail-ить, і assert що revert саме на ній (не earlier short-circuit, не later)
- `test_HashConsistencyCheck()` — `pubInputs.payloadHash != payloadHash` → revert PayloadHashMismatch
- `test_EpochInFutureReverts()` — `epochStartTs = block.timestamp + 600` → revert EpochInFuture
- `test_SessionKeyReplayReverts()` — submit success, потім re-submit same (deviceId, sessionId) → revert SessionKeyAlreadyUsed
- `test_PauseInterleave()` — submit success → pause → submit reverts → unpause → submit success again

---

## 6. Patterns

### Foundry conventions

```solidity
function test_OnlyOperatorCanSubmit() public {
    address notOperator = makeAddr("notOperator");
    
    vm.prank(notOperator);
    vm.expectRevert(
        abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector,
            notOperator,
            v3.OPERATOR_ROLE()
        )
    );
    v3.submitProof(...);
}
```

### Building valid PublicInputs

```solidity
PublicInputs memory pi = PublicInputs({
    deviceId: 1,
    sessionId: 100,
    epochStartTs: uint64(block.timestamp),
    lat_e7: 480000000,         // example: lat 48.0000
    lon_e7: 250000000,         // example: lon 25.0000
    lightLevel: 50000,
    tamperFlag: 0,
    payloadHash: bytes32(uint256(0xDEAD)),
    totalEnergyMWh: 1000
});
```

### Naming
- `test_Xxx()` for happy/sad path tests
- `test_RevertXxx()` for explicit revert tests
- `testFuzz_Xxx(uint256 input)` for fuzz tests (optional)

### Coverage

```bash
forge coverage --report lcov
forge coverage --report summary
```

Цільова метрика: 90% lines, 90% branches на V3 file.

---

## 7. Commit і push

Tested + green:

```bash
# Run all tests
forge test -vv

# Run specific test file
forge test --match-path test/V3_GapChecking.t.sol -vv

# Run specific test
forge test --match-test test_GapExactlyMax -vvv  # -vvv для trace
```

Commit message style (як уся historia today):

```
test(contracts): V3 <L-XXX or topic> — N tests

<Brief body explaining scope and any noteworthy decisions>
```

Push до main якщо solo work, або PR якщо preference. CI має пройти (compile + Slither + lint).

---

## 8. Відкриті питання — припускай defaults

Якщо натрапиш на ambiguity у contract логіці, **припускай default per V3_design.md §18** і коментар у tests. Перевірити з Олександром / Петром можна пізніше.

- **`MAX_GAP_SECONDS` — constant чи storage?** Зараз constant (48h). Tests припускають constant.
- **`setP256Verifier` / `setHonkVerifier` — timelock?** Зараз без. Test ascendantly через DEFAULT_ADMIN_ROLE.
- **`__gap[49]` — sufficient?** Не your concern, але якщо побачиш storage layout test — це для майбутніх V4 upgrades.
- **DeviceRegistry — upgradeable?** Зараз non-upgradeable. Ти testuesh interface, не implementation.
- **`isAuthorized` — on-chain чи aggregator?** On-chain (V3 calls registry). Test це.
- **`usedSessionKeys` cap?** No TTL. Mapping grows monotonic. Test не покриває growth (не practical).

---

## 9. Що surface back

Якщо знаходиш:
- **Real bug** у V3 (test exposes incorrect behavior) — повідомляй Петра одразу, він patch-ить
- **Ambiguity у design** — додай у §18 V3_design.md як новий Open Question (Q8, Q9, etc.)
- **Performance issue** (gas > expected) — log, але не блокує merge (gas estimates у §15 — rough, не SLA)
- **Slither warning level > Low** — investigate, deside якщо fix чи suppress з обґрунтуванням

---

## 10. Зв'язок

- **Петро** (Telegram / Signal / whatever you have): для design / scope clarifications
- **Олександр**: для ZK / cryptography / Noir circuit questions (буде доступний коли диплом allows)
- **Issue tracker** (GitHub Issues): для async questions / minor bugs

---

**Status:** mocks merged, design v0.2 актуальний, V3 body compiled clean. Ти маєш все що потрібно стартувати.

**Естимат твого роботи:** 8-12 годин зосередженого Foundry. TestBase + 1 simple test (V3_AccessControl) — 3-4 години. Решта — 5-8 годин залежно від edge cases.

Питай у Петра що-небудь що неясно. Якщо все clear — go.
