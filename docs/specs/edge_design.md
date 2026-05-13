# Edge Design — Hardware Abstraction Layer

**Status:** Draft v0.1
**Date:** 2026-05-13
**Author:** Petro Sydliarchuk
**Reviewers:** Oleksandr (security review, Poseidon parameter alignment), Taras (test coverage)
**Stage:** MVP Plan v1.4 — Етап 4a (паралельно з Етап 2 V3 contract work)
**Related:** `docs/specs/V3_design.md` (Solidity side of the protocol)

---

## 1. Scope

Цей документ описує **edge device layer** — софтверну частину яка живе на фізичному пристрої (Raspberry Pi / ESP32 + ATECC608B), збирає вимірювання, підписує канонічний payload і відправляє його у aggregator.

**У scope цього документа:**

- HAL Protocol — інтерфейс який реалізують усі edge devices (mock + real)
- MockEdgeDevice — софтверний симулятор для тестування
- Software P-256 signing — `cryptography` бібліотека PyCA
- Canonical payload serialization — детермінований binary format що матимуть і circuit і aggregator
- Hash function — SHA-256 placeholder з міграційним планом до Poseidon (BN254)

**Не у scope (deferred):**

- Реальні драйвери PZEM-017 (Modbus over RS485), GPS NEO-6M (UART NMEA), tamper switches (GPIO interrupts), BME280 (I2C) — Етап 4b коли залізо приїде
- ATECC608B HSM integration (заміна `P256Signer` software → hardware) — Етап 4b
- SQLite offline accumulation — Етап 4b (потребує aggregator API design що ще не зроблений)
- Aggregator integration (HTTP/MQTT клієнт) — Етап 5

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Edge device (RPi / ESP32)              │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  PZEM-017    │  │  NEO-6M      │  │ Tamper sw    │   │
│  │  (DC V/I)    │  │  (GPS fix)   │  │ (GPIO)       │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│         │ Modbus          │ UART            │ digital   │
│         ↓                 ↓                 ↓           │
│  ┌─────────────────────────────────────────────────┐    │
│  │              EdgeDevice (Protocol)              │    │
│  │  read_readings, read_gps, read_tamper_switch    │    │
│  │  get_public_key, sign_payload                   │    │
│  └─────────────────────┬───────────────────────────┘    │
│                        │                                │
│                        ↓ canonicalize + hash + sign     │
│  ┌─────────────────────────────────────────────────┐    │
│  │   ATECC608B HSM  (or software P256Signer)       │    │
│  │   private key never leaves chip                 │    │
│  └─────────────────────┬───────────────────────────┘    │
│                        │                                │
│                        ↓ SignedSubmission               │
│  ┌─────────────────────────────────────────────────┐    │
│  │   Offline accumulator (SQLite, deferred)        │    │
│  └─────────────────────┬───────────────────────────┘    │
│                        │                                │
└────────────────────────┼────────────────────────────────┘
                         ↓
                  ┌──────────────┐
                  │  Aggregator  │ → ZK proof → V3 contract
                  └──────────────┘
```

**Implementations of EdgeDevice Protocol:**

1. **MockEdgeDevice** (current, `edge/hal/mock_edge_device.py`) — software simulator з configurable scenarios. Для unit tests, integration tests, threat model demonstration.
2. **RaspberryPiEdgeDevice** (Етап 4b) — реальне залізо. Замінює sensor reads на конкретні драйвери, signing — на ATECC608B I2C calls.

Обидві реалізації **взаємозамінні** через Protocol — aggregator чи будь-який тестовий код, який приймає EdgeDevice, працює з обома.

---

## 3. Cryptography decisions

### 3.1 P-256 (secp256r1) — не secp256k1

**Decision (2026-05-13):** Edge використовує P-256 (NIST secp256r1) для підпису payload.

**V2 використовував secp256k1** (Ethereum native). V3 переходить на P-256.

**Чому P-256:**
- **ATECC608B native support** — production HSM підтримує саме P-256 апаратно. Private key не покидає чіп. secp256k1 потребував би software signing на edge → key exposure ризик
- **EIP-7212 / RIP-7212** — P-256 верифікація стає EVM precompile (proposal stage). Це майбутній gas saving
- **NIST standard** — broader cryptographic ecosystem support (CAVP-validated implementations, formal verification artifacts)

**Tradeoff:** P-256 не у EVM precompile сьогодні. V3 використовує `P256Verifier` wrapper (Daimo або FCL implementation) — ~300-400K gas. Коли EIP-7212 буде merged, swap-аємо на precompile (тому wrapper pattern — див. V3_design.md §9).

### 3.2 Signature format — raw r‖s (64 bytes), не DER

**Decision:** `P256Signer.sign()` повертає 64 байти raw concat: `r (32) || s (32)`, big-endian.

**Чому не DER:**
- DER encoding variable-length (typically 70-72 bytes для P-256) — gas-неефективно у calldata
- V3 contract очікує `bytes signature` parameter exactly 64 байти і викликає `P256Verifier.verify` з raw format
- Daimo/FCL P-256 verifier implementations беруть raw r/s — DER парсинг був би додатковий gas

**Implementation:** `signing.py` використовує `cryptography` lib яка повертає DER, потім `decode_dss_signature` декодує до `(r, s)` integers, далі `to_bytes(32, 'big')` для конкатенації.

### 3.3 Hash function — SHA-256 placeholder → Poseidon (BN254) migration

**Current (placeholder):** `canonical.py::compute_payload_hash` обчислює SHA-256 над canonical encoding.

**Target (Poseidon BN254):** Per V3_design.md §3.1, фінальна hash function — Poseidon на curve BN254. Параметри:
- t=3 (хешуємо 2 elements + 1 capacity)
- r_F=8 full rounds
- r_P=56 partial rounds
- alpha=5 S-box exponent

**Final freeze ownership:** Olexandr at v08 circuit design (Етап 3 тиждень 8).

**Migration steps when Poseidon params freeze:**

1. Замінити `hashlib.sha256(canonical_bytes).digest()` на Poseidon implementation у Python
2. Choices for Python Poseidon library:
   - [`poseidon-hash`](https://pypi.org/project/poseidon-hash/) PyPI — простий, але невпевнено чи матиме саме нашу parameter set
   - Custom implementation за параметрами Олександра — повний контроль, ~200 рядків
3. Update test `test_matches_direct_sha256_placeholder` → `test_matches_circuit_poseidon` з reference vectors від circuit
4. Same Poseidon parameters MUST бути identical у:
   - Edge Python (this module)
   - Aggregator TypeScript (`@aztec/foundation` Poseidon або `circomlibjs`)
   - Noir circuit (`std::hash::poseidon`)

**Cross-language consistency requirement:** Любий mismatch → silent hash inconsistency → silent verification failure. Це CRITICAL.

**Trigger для migration:** Олександр повертається з диплома, фіналізує v08 circuit, надсилає reference test vectors.

---

## 4. Canonical payload encoding

**Total size:** 2456 bytes = 56 metadata + 100 readings × 24 bytes

**Layout (big-endian, all integers):**

| Offset | Size | Field | Type |
|---|---|---|---|
| 0 | 8 | device_id | uint64 BE |
| 8 | 8 | session_id | uint64 BE |
| 16 | 8 | epoch_start_ts | uint64 BE |
| 24 | 8 | lat_e7 | **int64** BE (signed, two's complement) |
| 32 | 8 | lon_e7 | **int64** BE (signed) |
| 40 | 8 | light_level | uint64 BE |
| 48 | 8 | tamper_flag | uint64 BE (0 = OK, 1 = tamper) |
| 56 | 24 | readings[0] | (voltage_mv, current_ma, timestamp_ms) × uint64 BE |
| 80 | 24 | readings[1] | … |
| … | … | … | … |
| 2432 | 24 | readings[99] | … |

**Critical properties:**

1. **Deterministic** — same logical input → same bytes. No floats, no padding variability, no map iteration order
2. **Field order matches V3.PublicInputs struct** — V3 contract reads pubInputs у тому ж порядку для своїх 7 checks
3. **Field order matches Noir circuit public input order** — circuit бере ці байти і обчислює Poseidon
4. **Reading count fixed at 100** — `canonicalize()` raises `ValueError` якщо інша кількість. У майбутніх версіях можемо параметризувати, але для v08 circuit constraint count фіксований

**Why E7 coordinates:**
- 10⁷ multiplier дозволяє int32 storage з ~1.1 cm precision at equator
- Edge Python використовує int64 у dataclass щоб уникнути overflow під час обчислень, але серіалізує як int64 (signed) — у V3 контракті int32 теж достатньо

**Why uint64 voltage/current у мілівольтах/мілліамперах:**
- PZEM-017 максимум: 300V DC, 300A. mV/mA encoding → max ~3×10⁸ — comfortable у uint32, але uint64 для consistency з timestamp
- Float уникаємо повністю (різна serialization на різних архітектурах ARM/x86)

---

## 5. Threat model coverage

**Edge layer ловить (через canonical encoding properties):**

- **Reading tampering** — змінений voltage/current змінює canonical bytes → інший hash → invalid signature
- **Field reordering** — fixed serialization порядок, будь-яка зміна order дає інший hash
- **Truncation** — `canonicalize()` raises на reading count != 100
- **Unsigned vs signed encoding inconsistency** — lat_e7/lon_e7 явно signed (int64), уникає bug коли southern hemisphere coords інтерпретуються як величезні unsigned

**V3 contract ловить (поза edge layer):**

- **Replay attacks** — `usedSessionKeys` mapping rejects duplicate (deviceId, sessionId)
- **Stolen device** — `DeviceRegistry.isAuthorized(pubkey)` rejects revoked/unknown devices
- **Time manipulation** — gap-checking (`epochStartTs` monotonic) + epoch sanity (300s future drift tolerance)
- **Invalid ZK proof** — HonkVerifier reverts на proof що не match canonical hash
- **Invalid signature** — P256Verifier reverts якщо signature не match payload hash + pubkey

**Що НЕ ловиться ні edge ні V3 (out-of-band):**

- **Physical tamper з валідним sign** — якщо attacker reads valid private key з не-HSM device (or compromise HSM somehow), він може підписувати fake readings. Mitigation: ATECC608B з key never leaving chip (Етап 4b). Mock signer у тестах це симулює тільки software-wise
- **GPS spoofing з validity** — attacker spoof-ить GPS receiver сигналами, отримує валідні GPS fixes з fake coords. Mitigation: на рівні протоколу не вирішується, але aggregator може cross-check з historical pattern (Етап 5+)
- **Real-time clock manipulation** — якщо edge clock attacked, timestamp у reading може бути false. Mitigation: GPS time як authoritative source (sync кожен epoch), `epoch_start_ts` cross-checked з GPS fix
- **Light sensor spoofing** — flashlight на photoresistor під час night генерації. Mitigation: cross-correlation з PZEM readings — generation > threshold при low light → flag (aggregator logic, Етап 5)

---

## 6. EdgeDevice Protocol — interface specification

```python
class EdgeDevice(Protocol):
    def read_readings(self, n: int) -> tuple[Reading, ...]: ...
    def read_gps(self) -> GPSFix: ...
    def read_tamper_switch(self) -> bool: ...
    def get_public_key(self) -> bytes: ...
    def sign_payload(self, payload: CanonicalPayload) -> SignedSubmission: ...
```

**Why Protocol (structural typing), not ABC (nominal):**

- Future RaspberryPiEdgeDevice не зобов'язана inherit-итись — лише match-ити signatures
- Test mock и production driver мають однаковий контракт без shared parent
- Statically checkable (mypy/pyright) при бажанні
- Pythonic — duck typing principle

**Why frozen dataclasses for Reading/GPSFix/CanonicalPayload/SignedSubmission:**

- Immutable: payload не може мутувати між sign і send
- Hashable: можна використовувати як dict keys, set elements
- `__eq__` by value: tests можуть рівняти submissions безпосередньо
- No accidental mutation in pipeline

---

## 7. MockEdgeDevice — scenarios

Configuration via `MockEdgeDeviceConfig` dataclass — usable parameters:

| Field | Default | Purpose |
|---|---|---|
| `base_voltage_mv` | 5500 | Mid-day mid-load solar baseline |
| `base_current_ma` | 240 | … |
| `fixed_lat_e7` | 484517000 | Sniatyn |
| `fixed_lon_e7` | 255752000 | … |
| `tamper_active` | False | Tamper switch state |
| `light_level` | 5000 | Daytime lux baseline |
| `nighttime` | False | Override: all readings 0 |
| `sample_rate_hz` | 10 | 10 Hz → 100 readings per 10s epoch |

**Scenarios можливі через config inline у тестах:**

- Normal solar — defaults
- Nighttime — `MockEdgeDeviceConfig(nighttime=True)` → all readings (0, 0, ts)
- Tampered — `MockEdgeDeviceConfig(tamper_active=True)`
- GPS spoof — `MockEdgeDeviceConfig(fixed_lat_e7=-100000000, fixed_lon_e7=-700000000)` — Atlantic Ocean coords
- Custom voltage curve — variable through subclass override of `read_readings`

**Sce nario module (scenarios.py) deferred** — поточний inline config sufficient для current tests. Modularization доцільна коли тестів >50 і pattern reuse стає helpful.

---

## 8. Open work / migration plan

| Item | Trigger | Estimated effort |
|---|---|---|
| **Poseidon migration** | Olexandr freezes v08 params | 1-2 hours (replace hash fn + update 1 test, add reference vectors) |
| **ATECC608B integration** | Hardware arrives | 4-6 hours (I2C driver + key provisioning + replace P256Signer with hardware-backed) |
| **Real PZEM-017 driver** | Hardware arrives | 6-8 hours (pymodbus integration + register mapping + calibration) |
| **Real GPS driver** | Hardware arrives | 4-6 hours (UART NMEA parsing + fix validation + leap second handling) |
| **Real tamper GPIO** | Hardware arrives | 2 hours (interrupt handler + debouncing) |
| **SQLite offline accumulation** | Aggregator API design | 4-6 hours (storage interface + retry logic + dedup) |
| **Threat model integration tests** | Aggregator integration | 3-4 hours (end-to-end edge → aggregator → V3 + Honk circuit) |

---

## 9. Status of next steps

1. ✅ HAL skeleton committed (6fb3efc, 2026-05-13)
2. ✅ Python CI gate added (2488e08, 2026-05-13) — 34 tests blocking
3. ✅ Edge design v0.1 — this document
4. ⏳ Poseidon migration — blocked on Olexandr v08 circuit
5. ⏳ Real hardware drivers — blocked on hardware arrival (Етап 4b)
6. ⏳ Offline accumulation — blocked on aggregator API design

---

**Кінець Edge design v0.1.**
