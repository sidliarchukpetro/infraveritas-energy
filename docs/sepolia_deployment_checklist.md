# Sepolia Deployment Pre-Mortem Checklist

**Status:** Draft v0.1
**Date:** 2026-05-13
**Goal:** Розгорнути EnergyProofRegistryV3 + DeviceRegistry у Sepolia testnet з Etherscan-верифікованими контрактами.

Цей документ — checklist підготовки і виконання. Перед тим як починати deployment session, пройти всі пункти "Pre-deployment requirements". Без них session гарантовано впреться у блокери.

---

## 1. Pre-deployment requirements

### 1.1 Funding

- [ ] Deployer wallet має ≥ 0.1 Sepolia ETH (буферно — реальне витрачання ~0.02 ETH)
- [ ] Operator wallet окремий від deployer? Якщо так — теж funded для grantRole transactions

**Sources of Sepolia ETH:**
- Alchemy Sepolia faucet (потребує Alchemy account, 0.5 ETH/day)
- Infura Sepolia faucet (потребує Infura account)
- PoW faucet sepolia-faucet.pk910.de (вимагає mining у браузері)
- Coinbase Wallet Sepolia faucet (mobile)

### 1.2 RPC endpoint

- [ ] Sepolia RPC URL зафіксований у `.env`
- Опції:
  - Alchemy (free tier, реліабельний)
  - Infura (free tier)
  - Public RPCs: Ankr, Sepolia.dev — rate limited, не для broadcast
- Note: `forge script --broadcast` робить багато eth_sendTransaction — публічні RPCs можуть рейт-лімітити

### 1.3 Etherscan API

- [ ] Etherscan account → API key (free)
- Записати у `.env` як `ETHERSCAN_API_KEY`
- Потрібно для `--verify` flag — публікація source code до Etherscan після deployment
- Sepolia Etherscan: https://sepolia.etherscan.io

### 1.4 External verifier addresses

**P-256 verifier — три опції з адресами:**

| # | Implementation | Address | Sepolia status |
|---|---|---|---|
| A | Daimo P256Verifier (Solidity, EIP-7212-compatible, audited Veridise) | `0xc2b78104907F722DABAc4C69f826a522B2754De4` | Deterministic CREATE2 address used на усіх EVM chains. Deployed на Ethereum L1, OP, Base, Arbitrum. **Sepolia не явно підтверджений у Daimo docs** — треба cast-verify before relying |
| B | Vyper port (`pcaversaccio/p256-verifier-vyper`) | `0xD99D0f622506C2521cceb80B78CAeBE1798C7Ed5` | **Confirmed Sepolia + Holešky** |
| C | Self-deploy Daimo copy via `forge install daimo-eth/p256-verifier` + their `script/Deploy.s.sol` | новий address від нашого deployer | Always available, додаткові ~0.005 Sepolia ETH gas, наш контракт під нашим контролем |

**Verification протокол перед deployment:**

```bash
# Перевірити що Option A live на Sepolia
cast code 0xc2b78104907F722DABAc4C69f826a522B2754De4 --rpc-url $RPC_URL
# Якщо повертає "0x" — не задеплоєний на Sepolia, перейти на Option B

# Перевірити Option B як fallback
cast code 0xD99D0f622506C2521cceb80B78CAeBE1798C7Ed5 --rpc-url $RPC_URL
# Має повернути non-empty bytecode (Vyper port confirmed)
```

**Рекомендація:**

1. Спочатку перевірити Option A (Daimo canonical) — same address як на mainnet, gives mainnet parity
2. Якщо не доступна, використати Option B (Vyper port) — confirmed Sepolia
3. Якщо ANI of them не задовольняє audit чи compatibility — Option C (own copy)

**API differences:**

- Daimo `P256.verifySignature(hash, r, s, x, y)` — приймає signature як 5 окремих параметрів
- V3 contract `IP256Verifier.verify(payloadHash, signature, devicePubkey)` — payload, raw 64-byte signature, raw 64-byte pubkey
- **Наш `P256Verifier` wrapper** (`contracts/src/P256Verifier.sol`) має конвертувати V3 format → underlying verifier format. Це вже implemented у нашій codebase — verifier address може бути будь-якою сумісною implementation, wrapper isolates differences

**Honk verifier:**

- [ ] **БЛОКЕР:** Honk verifier auto-генерується з Noir circuit v08
- Циркуіт v08 поки що не існує — Олександр на дипломі
- Опції щоб не чекати:
  1. **Розгорнути з MOCK Honk verifier як placeholder.** Swap-нути на real пізніше через `V3.setHonkVerifier(newAddr)`. Це дозволяє почати тестувати V3 logic без circuit. AЛЕ — Sepolia deployment з mock — це "preview", не production-ready
  2. **Чекати v08 circuit.** Real Sepolia deployment тоді буде end-to-end testable
- Рекомендація: спочатку розгорнути з mock щоб verify deployment pipeline, потім re-deploy/swap коли circuit готовий

### 1.5 Test device keypair (optional)

Якщо хочемо зареєструвати тестовий device під час deployment (один transaction замість двох):

- [ ] Згенерувати P-256 keypair через edge код:
  ```python
  from hal import P256Signer
  signer = P256Signer()
  print("0x" + signer.public_key.hex())
  ```
- [ ] 64 байти hex → `TEST_DEVICE_PUBKEY` у `.env`
- [ ] Записати private key (саме PEM/hex) у safe місце — буде потрібен для signing у end-to-end tests після deployment
- [ ] Координати: Sniatyn defaults `TEST_DEVICE_LAT_E7=484517000`, `TEST_DEVICE_LON_E7=255752000`

Можна не реєструвати під час deployment — потім `cast send` від operator-а.

---

## 2. Deployment execution

### 2.1 Pre-flight checks

```bash
cd ~/projects/infraveritas-energy/contracts

# Confirm all env vars set
source ../.env
echo $PRIVATE_KEY | head -c 6   # має показати "0x" + prefix
echo $RPC_URL                    # має показати https://...
echo $OPERATOR_ADDRESS           # має показати 0x...
echo $P256_VERIFIER_ADDRESS      # має показати 0x...
echo $HONK_VERIFIER_ADDRESS      # має показати 0x... (mock OR real)
echo $ETHERSCAN_API_KEY | head -c 6
```

```bash
# Dry run БЕЗ --broadcast щоб побачити що буде розгорнуто
forge script script/Deploy.s.sol --rpc-url $RPC_URL
```

Очікую вивід з gas estimate і логами що покажуть deployer/operator/verifier addresses. Якщо щось не так — fix перш ніж broadcast.

### 2.2 Broadcast

```bash
forge script script/Deploy.s.sol \
  --rpc-url $RPC_URL \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

Очікую:
- 4 транзакції (DeviceRegistry, V3 implementation, V3 proxy initialization, optional test device registration)
- Verification status logs після кожного контракту
- Final summary з addresses

### 2.3 Save deployment artifacts

```bash
# Foundry зберігає broadcast results
ls broadcast/Deploy.s.sol/11155111/   # 11155111 = Sepolia chainId
cat broadcast/Deploy.s.sol/11155111/run-latest.json | jq '.transactions[].contractAddress'
```

- [ ] Записати у `docs/deployments/sepolia-{date}.md`:
  - DeviceRegistry address
  - V3 proxy address
  - V3 implementation address
  - P-256 verifier address used
  - Honk verifier address used (з пометою mock чи real)
  - Deployment transaction hashes
  - Deployer address
  - Operator address
  - Block number

---

## 3. Post-deployment verification

### 3.1 Etherscan rendering

- [ ] Перейти на `https://sepolia.etherscan.io/address/<DeviceRegistry>` — має показати verified contract source
- [ ] Те саме для V3 proxy і V3 implementation
- [ ] "Read Contract" tab працює — натиснути `isAuthorized`, `deviceCount`, etc.
- [ ] "Write Contract" tab дозволяє connect wallet і викликати functions

### 3.2 Role-based access works

```bash
# Перевірити що deployer має DEFAULT_ADMIN_ROLE на обох контрактах
cast call $DEVICE_REGISTRY_ADDR "hasRole(bytes32,address)(bool)" \
  0x0000000000000000000000000000000000000000000000000000000000000000 \
  $DEPLOYER_ADDR --rpc-url $RPC_URL

# Перевірити що operator має OPERATOR_ROLE
cast call $DEVICE_REGISTRY_ADDR "hasRole(bytes32,address)(bool)" \
  $(cast keccak "OPERATOR_ROLE") \
  $OPERATOR_ADDR --rpc-url $RPC_URL
```

### 3.3 Cross-contract wiring

```bash
# V3 знає про DeviceRegistry?
cast call $V3_PROXY_ADDR "deviceRegistry()(address)" --rpc-url $RPC_URL
# Має повернути $DEVICE_REGISTRY_ADDR

# P256 і Honk verifiers wired?
cast call $V3_PROXY_ADDR "p256Verifier()(address)" --rpc-url $RPC_URL
cast call $V3_PROXY_ADDR "honkVerifier()(address)" --rpc-url $RPC_URL
```

### 3.4 End-to-end test submission (якщо test device registered)

- [ ] Згенерувати mock signed submission через MockEdgeDevice (edge/hal)
- [ ] Створити mock ZK proof (or skip якщо HonkVerifier — mock)
- [ ] Викликати `V3.submitProof(...)` від operator account
- [ ] Перевірити що транзакція success
- [ ] Перевірити що ProofSubmitted event emitted

Якщо це працює end-to-end — V3 на Sepolia реально функціонує.

---

## 4. Admin transfer to multisig (deferred to Етап 8)

**Не для першого deployment.** Записано для контексту.

Перед mainnet:
1. Setup Gnosis Safe multisig (e.g. 2-of-3 з Petro / Олександр / зовнішній auditor)
2. Grant DEFAULT_ADMIN_ROLE до Safe address на обох контрактах
3. Revoke DEFAULT_ADMIN_ROLE з deployer EOA
4. Verify: deployer більше не може викликати admin functions

Це pattern для production. Sepolia testnet — все на deployer EOA, multisig не потрібен.

---

## 5. Known blockers (як зараз 2026-05-13)

| Blocker | Impact | Resolution |
|---|---|---|
| Noir circuit v08 не існує | Real Honk verifier не доступний | (a) Deploy з mock Honk → swap пізніше, (b) Чекати Olexandr |
| Sepolia ETH у deployer wallet | Не можна broadcast | Faucet до deployment session |
| Etherscan API key | `--verify` flag не працює | Free signup, ~5 хв |
| P-256 verifier Sepolia address | Не можна вказати у env | Research before session, fallback — deploy own |

---

## 6. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `--verify` fails post-deploy | Medium | Low — contracts deployed, verification можна повторити | `forge verify-contract` standalone command |
| Deployer wallet has DEFAULT_ADMIN_ROLE on Sepolia "forever" | High | Low for testnet, would be High for mainnet | Acceptable for Sepolia. Transfer to multisig у Етап 8 для mainnet |
| Mock Honk verifier accidentally promoted to mainnet | Low | **Catastrophic** | Process: mainnet deployment ONLY with explicit `HONK_VERIFIER_ADDRESS` pointing to real verifier deployed from circuit v08. Add check у Deploy.s.sol: `require(!isMock, ...)` |
| Gas estimate inaccurate, deployment fails mid-way | Low | Medium — partial deployment | Run dry run first (`forge script` без `--broadcast`), buffer 2x gas |
| Etherscan rate limit during multi-contract verification | Medium | Low | Wait + retry, або verify контракти one-by-one |

---

## 7. Rollback / re-deploy

Якщо deployment пішов не як треба після broadcast:

- **Wrong constructor args (V3 implementation):** не пофіксити implementation у місці. Deploy new V3 implementation, upgrade proxy через `UUPSUpgradeable.upgradeToAndCall`. Старий implementation просто залишається orphan
- **Wrong proxy address:** не виходить, proxy CREATE-ed. Деplay new proxy, прив'язати до нового. Старий orphan
- **Wrong DeviceRegistry constructor args:** non-upgradeable. Deploy new, потім `V3.setDeviceRegistry(newAddr)`. Старий orphan
- **Wrong verifier address:** `V3.setP256Verifier(addr)` або `V3.setHonkVerifier(addr)` від admin
- **Test device registered with wrong coords:** `DeviceRegistry.revokeDevice(pubkey)` then re-register

Sepolia: orphans коштують нам ~0.005 ETH ($5-10) gas на orphan. Manageable.

---

## 8. Status of next steps

1. ⏳ Funding deployer wallet (Sepolia ETH)
2. ⏳ Research current Daimo P256Verifier Sepolia address
3. ⏳ Decision: deploy з mock Honk OR чекати circuit v08
4. ⏳ Etherscan API key
5. ⏳ Dry run Deploy.s.sol з усіма env vars
6. ⏳ Broadcast і verify
7. ⏳ Post-deployment validation (Sections 3.1-3.4)
8. ⏳ Document у `docs/deployments/sepolia-{date}.md`

---

**Кінець Sepolia deployment checklist v0.1.**
