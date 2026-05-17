# InfraVeritas Energy

Physical asset verification protocol for energy generation. Edge devices read meter data, sign it with hardware-protected keys, and submit zero-knowledge proofs to a smart contract that verifies authenticity end-to-end without trusting any single party.

## Status

**Stage:** MVP розробка — Етап 2 (Solidity контракти) завершений, Етап 3 (ZK circuit v08) і Етап 4a (edge HAL) у роботі.

| Трек | Що на `main` | Статус |
|---|---|---|
| Solidity (V3 + DeviceRegistry) | `contracts/src/` | 33 tests, Slither blocking, deployment scripts локально перевірені через anvil |
| Edge HAL (Python) | `edge/hal/` | 34 tests, software P-256 signer, MockEdgeDevice з configurable scenarios |
| ZK circuit | `zk/` | v06 у legacy V2 deployment, v08 у дизайні (Олександр) |
| Aggregator | `aggregator/` | v1 legacy від V2, v2 redesign — після circuit v08 |
| Documentation | `docs/specs/` | V3 design v0.3, Edge design v0.1, Sepolia checklist, handoff docs |

## Live dashboard

**Public observability:** [sidliarchukpetro.github.io/infraveritas-energy/dashboard.html](https://sidliarchukpetro.github.io/infraveritas-energy/dashboard.html)
*(після увімкнення GitHub Pages у Settings — буде доступно)*

Dashboard має dual-mode: розробник з aggregator на localhost бачить live proof timings, зовнішні спостерігачі — on-chain історію через [The Graph subgraph](https://thegraph.com/studio/subgraph/infraveritas-energy-sepolia) (Sepolia).

## Architecture

```
┌──────────────┐    ┌──────────────┐    ┌─────────────────────┐
│ Edge device  │    │  Aggregator  │    │  V3 contract        │
│              │    │              │    │  (Sepolia/mainnet)  │
│  PZEM-017    │───▶│  Noir v08    │───▶│                     │
│  NEO-6M GPS  │    │  proof gen   │    │  DeviceRegistry     │
│  ATECC608B   │    │              │    │  P256Verifier       │
│  (HSM)       │    │              │    │  HonkVerifier       │
└──────────────┘    └──────────────┘    └─────────────────────┘
     signed              ZK proof              7 checks +
     payload                                   gap detection
     (2456 bytes)
```

Reading → canonical payload (2456 bytes) → P-256 signature на edge → ZK proof на aggregator → on-chain settlement у V3 контракті.

Детальна архітектура: `docs/specs/V3_design.md` і `docs/specs/edge_design.md`.

## Repository structure

```
contracts/          Foundry project — V3 + DeviceRegistry + tests + scripts
  src/              EnergyProofRegistryV3.sol, DeviceRegistry.sol, interfaces
  test/             33 tests (24 DeviceRegistry + 9 V3 integration)
  script/           Deploy.s.sol, DeployLocal.s.sol, DeployDeviceRegistry.s.sol
  legacy/v2/        V2 контракт (раніше розгорнутий на Sepolia)

edge/               Python edge device HAL і симулятор
  hal/              EdgeDevice Protocol, MockEdgeDevice, P256Signer, canonical
  tests/            34 pytest tests
  legacy/           V1 edge script (secp256k1, replaced by V3 P-256 pattern)

zk/                 Noir circuits (v06 deployed; v08 у дизайні)

aggregator/         TypeScript aggregator (v1 legacy; v2 чекає circuit v08)

docs/
  specs/            V3 design, edge design, deployment checklist
  handoffs/         Олександру (V3 review), Тарасу (test brief)
  deployment.md     Foundry deployment інструкції
  adr/              Architecture Decision Records

audit/              Audit preparation materials

scripts/            Утилітарні скрипти
```

## Getting started

### Solidity (contracts)

Потребує [Foundry](https://book.getfoundry.sh/) (forge, anvil, cast).

```bash
cd contracts
forge build
forge test -vvv
```

Локальне end-to-end розгортання через anvil:

```bash
# Terminal 1: локальна EVM nodе
anvil

# Terminal 2: розгортання
cd contracts
forge script script/DeployLocal.s.sol --rpc-url http://localhost:8545 --broadcast
```

Розгорне DeviceRegistry, V3 implementation + proxy, mock verifiers. Anvil default accounts: account[0] = admin/deployer, account[1] = operator.

### Edge HAL (Python)

Потребує Python 3.10+.

```bash
cd edge
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[test]"
pytest -v
```

Має пройти 34 тести за <1 секунду.

Швидке demo signing:

```python
from hal import MockEdgeDevice, Reading, CanonicalPayload

device = MockEdgeDevice()
readings = device.read_readings(100)

payload = CanonicalPayload(
    device_id=42, session_id=1, epoch_start_ts=1778000000,
    lat_e7=484517000, lon_e7=255752000,
    light_level=5000, tamper_flag=0,
    readings=readings,
)
submission = device.sign_payload(payload)
print(f"payload_hash: {submission.payload_hash.hex()}")
print(f"signature:    {submission.signature.hex()}")
print(f"public_key:   {submission.public_key.hex()}")
```

## Key documents

- `docs/specs/V3_design.md` — Solidity контракт дизайн і рішення (v0.3)
- `docs/specs/edge_design.md` — Edge HAL дизайн і migration plan (v0.1)
- `docs/deployment.md` — Foundry deployment інструкції (anvil + Sepolia)
- `docs/sepolia_deployment_checklist.md` — Sepolia pre-mortem (v0.1)
- `docs/handoffs/2026-05-13-oleksandr-v3-review.md` — Відкриті питання для security review

## CI

GitHub Actions запускає три jobs на кожен push до `main` і `develop`:

- **forge-test** — компіляція + 33 Solidity тести через Foundry
- **edge-test** — 34 Python тести через pytest (паралельно з forge-test)
- **slither** — static analysis блокуючий на нових V3 + DeviceRegistry контрактах, інформаційний на legacy v2

Усі три блокуючі. CI green обов'язковий для merge у protected branches.

## Контрибутори

- **Petro Sydliarchuk** — founder, structural engineer, V3 design та edge HAL
- **Oleksandr Sydliarchuk** — CTO, Noir circuit, security review
- **Taras** — V3 Foundry test coverage

## License

Private repository, license TBD перед публічним релізом.
