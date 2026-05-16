# Phase 5 — Implementation Notes

*Written 2026-05-16, post subgraph + dashboard deployment*
*Scope: on-chain indexing + public observability layer (architectural Phase 5 / 8-phase roadmap)*

---

## 1. Status snapshot

| Component | Що | Стан |
|---|---|---|
| Subgraph schema | `Device`, `Submission`, `DailyStat`, `Protocol` entities | ✅ deployed |
| V3 indexing | `ProofSubmitted` event → `Submission` + `DailyStat` + `Protocol` counters | ✅ working |
| DeviceRegistry indexing | `DeviceRegistered/Revoked/Reactivated/Suspended` → `Device` lifecycle | ✅ working |
| Subgraph hosting | The Graph Studio (Sepolia testnet) | ✅ live |
| Dashboard | `dashboard.html` dual-mode (live aggregator + public subgraph) | ✅ rendering |
| GitHub Pages | публічний URL для dashboard | ⏳ потребує клацання у Settings (Task 2 у handoff) |
| Subgraph Studio metadata | Source Code URL + Categories | ⏳ ручне заповнення (Task 3 у handoff) |

---

## 2. Architectural decisions

### 2.1 Device vs Submission — **незалежні** entities

**Проблема:** як зв'язати `Submission` (з V3 події) з `Device` (з DeviceRegistry)?

**Реальність V3 події `ProofSubmitted`:**
```solidity
event ProofSubmitted(
    bytes32 indexed deviceId,    // ← це bytes32(uint64(payload.device_id))
    bytes32 indexed sessionKey,  // ← keccak256(device_id || session_id)
    uint64 timestamp,
    uint64 gap,
    bool postDisconnection
);
```

`deviceId` тут — НЕ криптографічний `pubKeyHash` з DeviceRegistry, а **user-facing semantic ID** з payload (`uint64 device_id`, у нашому випадку — `42`). Це padded у `bytes32` через `bytes32(uint256(uint64))`.

**А `DeviceRegistry.DeviceRegistered` емітить:**
```solidity
event DeviceRegistered(
    bytes32 indexed pubKeyHash,  // ← keccak256(P-256 pubkey bytes)
    int32 latE7, int32 lonE7,
    uint64 timestamp,
    indexed address operator
);
```

Тобто `pubKeyHash` — це інший простір ідентифікаторів. Зв'язку між цими двома bytes32 у event payload **немає**.

**Рішення:** `Submission` і `Device` — окремі entities з різними ID:
- `Submission.id = sessionKey` (унікальний per V3's anti-replay)
- `Submission.deviceIdBytes` = сирий `bytes32` з події (semantic ID)
- `Device.id = pubKeyHash` (зі DeviceRegistry події)

`DailyStat` теж keyed by `deviceIdBytes` (не Device.id), бо інакше довелось би мати окремий on-chain mapping що зараз нема.

**Що це означає для майбутнього:** якщо V4 буде емітити `pubKeyHash` як третій indexed topic у `ProofSubmitted`, тоді можна буде встановити `Submission.device: Device!` зв'язок без змін індексу історичних даних — просто додати relation у новий handler. До того часу — два паралельних світи, що нормально для observability.

### 2.2 startBlock — точні значення з Etherscan

| Contract | startBlock |
|---|---|
| `EnergyProofRegistryV3` (proxy) | `10852229` |
| `DeviceRegistry` | `10851844` |

**Як знайти для майбутніх deploy-ів:**

1. Open Etherscan: `https://sepolia.etherscan.io/address/<address>` (для mainnet — без `sepolia.`)
2. На сторінці контракту біля "Contract Creator" видно: `Created by 0x... at txn 0x...`
3. Клацнути на TX → блок-номер у "Block" полі

Для V3 proxy — НЕ використовувати блок imp деплою. `ProofSubmitted` події емітятся з proxy address, тому startBlock = блок створення proxy. Імплементацію події не емітіть (вона никогда не викликається напряму).

**Симптом** при неправильному startBlock: subgraph indexes від raw block 0, тратить хвилини/години на historical sync, або пропускає події бо стартує **після** першого event-у.

### 2.3 Dual-mode dashboard — один файл, два режими

**Проблема:** треба і live monitoring для розробника (з aggregator на localhost), і публічна сторінка для зовнішніх (без aggregator).

**Розглянуті варіанти:**
- ❌ Два окремих файли (`dashboard.html` + `public.html`) — duplicate code, drift
- ❌ Окремий public deployment з тільки subgraph-режимом — те ж дублювання
- ✅ **Один файл з auto-detect** на startup

**Як працює** (`dashboard.html` lines 225-270):

```javascript
// Mode detection — try local aggregator first
const probe = await fetch('http://localhost:3000/health', { signal: AbortSignal.timeout(800) });
if (probe.ok) {
    mode = 'live';         // aggregator → real-time proof timings
} else {
    mode = 'public';       // subgraph → on-chain history only
}
```

- **Live mode:** опитує `http://localhost:3000`, refresh 5s, видно proof generation latency
- **Public mode:** опитує GraphQL endpoint TheGraph, refresh 30s, тільки on-chain дані (без proof timings)

Banner угорі сторінки змінюється відповідно. Footer показує джерело даних з кольоровим індикатором (зелений = aggregator live, синій = subgraph).

**Чому це краще ніж окремі файли:**
- Один URL для всіх — від dev до зовнішнього спостерігача
- Auto-fallback — якщо у розробника aggregator випадково не запущений, dashboard все одно показує дані
- Один codebase для змін — оновив схему `Submission` — оновив обидва шляхи у одному місці

---

## 3. File inventory

```
subgraph/
├── schema.graphql                  # Device, Submission, DailyStat, Protocol
├── subgraph.yaml                   # V3 + DeviceRegistry datasources, startBlocks
├── package.json                    # @graphprotocol/graph-cli як devDep
├── abis/
│   ├── EnergyProofRegistryV3.json  # для events що тут indexed
│   └── DeviceRegistry.json
└── src/
    ├── v3-mapping.ts               # handleProofSubmitted (Submission + DailyStat + Protocol)
    ├── device-registry-mapping.ts  # handle* для 4 lifecycle events
    └── utils.ts                    # shared helpers (loadProtocol, dayKey, тощо)

dashboard.html                      # ~24 КБ single-file, dual-mode, no build
```

---

## 4. Operational notes

### 4.1 Deploy Key — обов'язково regenerate якщо засвічений у чаті

**⚠️ Якщо Deploy Key з'являвся у будь-якому повідомленні / скріні — regenerate негайно у Subgraph Studio:**

1. Studio → subgraph page → **Auth & Deploy** tab
2. **Regenerate** button (інвалідує старий ключ, видає новий)
3. Зберегти безпечно у password manager / 1Password / secrets file що не йде у git

Старий ключ після regenerate більше не приймається `graph deploy`. Нагадування: **Petro має це зробити для ключа що був у чаті раніше.**

### 4.2 GraphQL endpoint URL — стабільний

Поточний endpoint:
```
https://api.studio.thegraph.com/query/<id>/infraveritas-energy-sepolia/<version>
```

`<version>` змінюється при `graph deploy` з новим version label (`v0.0.1`, `v0.0.2`...). Старі версії **залишаються доступними** — фронтенди можуть продовжувати query на старій версії доки не оновлять URL.

`dashboard.html` має URL зашитий — при re-deploy з новим version треба:
1. оновити URL у `dashboard.html` constant
2. commit + push

### 4.3 Re-deploy у Studio — version label discipline

```bash
cd subgraph
graph codegen
graph build
graph deploy --version-label v0.0.X --deploy-key <DEPLOY_KEY> infraveritas-energy-sepolia
```

**Version label semantics:**
- v0.0.1 → перший deploy
- v0.0.2 → schema changes / mapping fixes (поточна)
- v0.0.3 → наступний коли щось зміниться
- bump патч-версію за кожен significant change у `schema.graphql` або handlers

Старі версії доступні у Studio для rollback / debugging — не видаляти доки нова не verified working.

### 4.4 Subgraph не показує нові події

**Симптоми:**
- `totalSubmissions` у Protocol не зростає після нової `submitProof` транзакції
- Або submission video у dashboard public mode

**Діагностика:**
1. Studio → subgraph → **Status** → перевірити "Synced to block N" vs latest block Sepolia
2. Якщо sync відстає — почекати кілька хвилин (TheGraph indexer догнетьte)
3. Якщо "Failed" — клацнути на error → перевірити `subgraph/src/*.ts` mapping handlers на runtime errors

**Найчастіша причина fail:** event ABI зчитує `int32` як `i32` у assemblyscript, а handler присвоює у `Int!` schema field. `Int!` у GraphQL — це 32-bit signed, тому має поміщатись. Якщо BigInt — використовувати `BigInt.fromI32(x)`.

### 4.5 Local subgraph testing

Не потрібен node для smoke test схеми. `graph build` досить:
```bash
cd subgraph
npm install
graph codegen   # генерує types з schema + ABIs
graph build     # перевіряє mappings на compile errors
```

Якщо `graph build` зелений — значить handlers компілюються у WASM коректно. Runtime errors (null refs, etc.) видно тільки на TheGraph indexer.

---

## 5. Known limitations

1. **`deviceIdBytes` не linkable до `Device.pubKeyHash`** — see §2.1. Workaround: aggregator + V3_design.md документують mapping окремо. Real fix потребує V4 event redesign.

2. **Dashboard URL — hardcoded у `dashboard.html`** — при re-deploy subgraph треба і HTML оновити. Можна було б винести у URL query param, але це додає complexity для одного use case.

3. **Public mode не показує proof generation timings** — за дизайном. Ця інформація доступна лише у aggregator логах. Якщо потрібна публічна — треба індексувати у subgraph (зараз ні).

4. **No mainnet datasources** — `subgraph.yaml` має тільки `network: sepolia`. При деплої на mainnet — клонувати config, замінити addresses + network, окремий deploy у Studio як `infraveritas-energy-mainnet`.

---

## 6. Cross-reference

- `phase4_implementation_notes.md` — backend (aggregator + Postgres + validation pipeline)
- `deployments/sepolia-mvp-2026-05.json` — contract addresses що йдуть у `subgraph.yaml`
- `docs/specs/phase5_design.md` — original design (якщо існує — TBD)
- `subgraph/README.md` — quickstart для розробника
