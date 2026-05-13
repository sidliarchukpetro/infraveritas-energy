# Handoff: Sepolia Deployment — V3 + DeviceRegistry + HonkVerifier

**Author:** Petro Sydliarchuk
**Recipient:** Taras Sidliarchuk
**Date:** 2026-05-14
**Estimated time:** 1–2 години активної роботи + час очікування confirmations
**Output:** PR з deployment artifacts на main

---

## Контекст

V3 + DeviceRegistry + real HonkVerifier готові на main після твого test suite (85 tests pass, branch coverage 100%, Slither 0 findings). Локально через anvil все працює end-to-end. Тепер перший real-world deployment на Sepolia testnet для validation перед mainnet.

Це operational task — без архітектурних рішень. Sepolia ETH без вартості; deployment fully reversible (можна redeploy при помилці).

---

## Що у тебе є

- **Wallet:** MetaMask Петра (той самий який використовуємо для оплат — маєш доступ)
- **Repo:** клонований локально, branch main синхронізована
- **Скрипти:** всі готові у contracts/script/:
  - Deploy.s.sol — основний (V3 + DeviceRegistry), очікує env HONK_VERIFIER_ADDRESS
  - DeployHonkVerifier.s.sol — standalone HonkVerifier
- **Документація:** docs/deployment.md (загальна), docs/sepolia_p256_verifier.md (P-256 addresses checklist)


---

## Що потрібно отримати

1. **Sepolia ETH** — ~0.5 ETH у Sepolia address Петрового MetaMask
   Faucets:
   - https://sepoliafaucet.com (Alchemy)
   - https://www.infura.io/faucet/sepolia
   - https://cloud.google.com/application/web3/faucet/ethereum/sepolia

2. **Sepolia RPC URL** — Alchemy або Infura free tier
   - Sign up на https://alchemy.com → create app → Network: Sepolia
   - Формат: https://eth-sepolia.g.alchemy.com/v2/<KEY>

3. **Etherscan API key** — https://etherscan.io/myapikey


---

## Out of scope (Петро робить)

- Admin role transfer на Gnosis Safe multisig — security-critical
- Production mainnet deployment
- Architectural changes


---

## Pre-deploy verification

    cd ~/projects/infraveritas-energy/contracts
    git pull origin main
    forge build
    forge test

Set env variables (save в .env.sepolia локально, НЕ commit):

    export SEPOLIA_RPC_URL="https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY"
    export PRIVATE_KEY="0x..."
    export ETHERSCAN_API_KEY="YOUR_ETHERSCAN_KEY"
    export OPERATOR_ADDRESS="0x..."

Verify wallet balance >= 0.3 ETH:

    cast balance $(cast wallet address --private-key $PRIVATE_KEY) --rpc-url $SEPOLIA_RPC_URL

Verify P-256 verifier на Sepolia (Daimo canonical):

    cast code 0xc2b78104907F722DABAc4C69f826a522B2754De4 --rpc-url $SEPOLIA_RPC_URL | head -c 50

Expected non-zero bytecode. Fallback Vyper port: 0xD99D0f622506C2521cceb80B78CAeBE1798C7Ed5


---

## Step 1: Deploy HonkVerifier

    cd ~/projects/infraveritas-energy/contracts
    forge script script/DeployHonkVerifier.s.sol \
        --rpc-url $SEPOLIA_RPC_URL \
        --private-key $PRIVATE_KEY \
        --broadcast --verify \
        --etherscan-api-key $ETHERSCAN_API_KEY -vvv

Очікуваний output: "HonkVerifier Deployed Address: 0x..."

Capture цю адресу:

    export HONK_VERIFIER_ADDRESS="0x..."  # paste from output
    export P256_VERIFIER_ADDRESS="0xc2b78104907F722DABAc4C69f826a522B2754De4"

Verify на Etherscan: https://sepolia.etherscan.io/address/$HONK_VERIFIER_ADDRESS — Contract tab має показувати source code.


---

## Step 2: Deploy DeviceRegistry + V3 stack

    forge script script/Deploy.s.sol \
        --rpc-url $SEPOLIA_RPC_URL \
        --private-key $PRIVATE_KEY \
        --broadcast --verify \
        --etherscan-api-key $ETHERSCAN_API_KEY -vvv

Очікуваний output (Deployment Complete):
- DeviceRegistry
- V3 implementation
- V3 proxy
- P256 verifier (extern)
- Honk verifier (extern)
- Admin (deployer)
- Operator

Capture всі адреси.


---

## Step 3: Post-deploy verification

    export DEVICE_REGISTRY="0x..."
    export V3_PROXY="0x..."
    DEFAULT_ADMIN_ROLE=0x0000000000000000000000000000000000000000000000000000000000000000
    ADMIN_ADDRESS=$(cast wallet address --private-key $PRIVATE_KEY)

Перевірки (кожна має повернути expected value):

1. Admin role на V3:

    cast call $V3_PROXY "hasRole(bytes32,address)(bool)" $DEFAULT_ADMIN_ROLE $ADMIN_ADDRESS --rpc-url $SEPOLIA_RPC_URL
    # Expected: true

2. Operator role на V3:

    OPERATOR_ROLE=$(cast call $V3_PROXY "OPERATOR_ROLE()(bytes32)" --rpc-url $SEPOLIA_RPC_URL)
    cast call $V3_PROXY "hasRole(bytes32,address)(bool)" $OPERATOR_ROLE $OPERATOR_ADDRESS --rpc-url $SEPOLIA_RPC_URL
    # Expected: true

3. V3 знає правильний DeviceRegistry:

    cast call $V3_PROXY "deviceRegistry()(address)" --rpc-url $SEPOLIA_RPC_URL
    # Expected: equals $DEVICE_REGISTRY

4. V3 знає правильні verifiers:

    cast call $V3_PROXY "p256Verifier()(address)" --rpc-url $SEPOLIA_RPC_URL
    cast call $V3_PROXY "honkVerifier()(address)" --rpc-url $SEPOLIA_RPC_URL

Якщо хоч одна перевірка не повертає expected — STOP, повертайся з output.


---

## Step 4: Документація результату

Створи `deployments/sepolia-mvp-2026-05.json` (новий каталог `deployments/` у repo root):

    {
      "network": "sepolia",
      "chainId": 11155111,
      "deployedAt": "2026-05-14T...",
      "deployer": "0x...",
      "operator": "0x...",
      "contracts": {
        "deviceRegistry": { "address": "0x...", "deploymentTx": "0x...", "deploymentBlock": 0, "etherscan": "https://sepolia.etherscan.io/address/0x..." },
        "v3Implementation": { "address": "0x...", "deploymentTx": "0x...", "deploymentBlock": 0, "etherscan": "https://sepolia.etherscan.io/address/0x..." },
        "v3Proxy": { "address": "0x...", "deploymentTx": "0x...", "deploymentBlock": 0, "etherscan": "https://sepolia.etherscan.io/address/0x..." },
        "honkVerifier": { "address": "0x...", "deploymentTx": "0x...", "deploymentBlock": 0, "etherscan": "https://sepolia.etherscan.io/address/0x..." },
        "p256Verifier": { "address": "0xc2b78104907F722DABAc4C69f826a522B2754De4", "note": "External Daimo canonical RIP-7212" }
      },
      "verificationChecks": {
        "adminHasDefaultAdminRole": true,
        "operatorHasOperatorRole": true,
        "v3KnowsCorrectDeviceRegistry": true,
        "v3KnowsCorrectP256Verifier": true,
        "v3KnowsCorrectHonkVerifier": true
      }
    }

deploymentTx і deploymentBlock знайдеш у `broadcast/Deploy.s.sol/11155111/run-latest.json`.


---

## Step 5: PR

    git checkout -b deploy/sepolia-mvp-2026-05
    git add deployments/sepolia-mvp-2026-05.json
    git commit -m "deploy(sepolia): MVP V3 stack deployed 2026-05-14"
    git push origin deploy/sepolia-mvp-2026-05
    gh pr create --title "deploy(sepolia): MVP V3 stack" --body "Per docs/handoffs/2026-05-14-taras-sepolia-deployment.md. All checks pass. Admin transfer pending Petro."

---

## Якщо щось failед

1. Faucet не дає ETH → інший faucet, або повідом Петру
2. forge script revertов → перевір cast balance, збільш, retry
3. Verification failед → forge verify-contract окремо
4. Post-deploy check returnає неправильне значення → STOP, документуй output, повертайся

---

## Estimated cost

Sepolia ETH burnнеться на:
- HonkVerifier: ~30-40M gas × 2 gwei = ~0.07 ETH
- DeviceRegistry + V3 implementation + proxy: ~7M gas × 2 gwei = ~0.02 ETH
- 2 grantRole txs: ~150k gas × 2 gwei = ~0.001 ETH
- Total: ~0.1 ETH (free через faucet)

---

## Після merge цього PR

Петро виконає admin role transfer на multisig — security-критичний крок, не входить у твій scope.
