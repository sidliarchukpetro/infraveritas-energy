# Розгортання — інструкція

Сценарії Foundry знаходяться у `contracts/script/`. Три сценарії:

- `Deploy.s.sol` — основний, для тестової мережі і виробництва
- `DeployLocal.s.sol` — для локального anvil з заглушками верифікаторів
- `DeployDeviceRegistry.s.sol` — лише DeviceRegistry (коли V3 вже розгорнутий)

---

## Локальне тестування через anvil

**Термінал 1** — запуск локального вузла:

```bash
anvil
```

Anvil виводить десять стандартних акаунтів з приватними ключами. Запам'ятовуй або скопіюй акаунт 0 і акаунт 1 — їх використовує сценарій за замовчуванням.

**Термінал 2** — розгортання:

```bash
cd contracts
forge script script/DeployLocal.s.sol \
  --rpc-url http://localhost:8545 \
  --broadcast
```

Сценарій виведе адреси всіх розгорнутих контрактів:
- DeviceRegistry
- V3 implementation
- V3 proxy (це адреса з якою працює агрегатор)
- MockP256Verifier
- MockHonkVerifier

За замовчуванням:
- Акаунт 0 anvil (`0xf39F...`) — деплоєр і адмін
- Акаунт 1 anvil (`0x7099...`) — оператор з OPERATOR_ROLE на обох контрактах

Якщо хочеш свої акаунти — встанови `PRIVATE_KEY` і `OPERATOR_ADDRESS` у `.env` перед запуском.

---

## Розгортання у Sepolia

**Перед запуском перевір:**

- Є ETH у гаманці деплоєра (мінімум 0.1 ETH для розгортання повного стеку)
- Є API ключ Etherscan для перевірки контрактів
- Знаєш адресу справжнього P-256 верифікатора (Daimo або FCL у Sepolia)
- Знаєш адресу HonkVerifier — для першого розгортання можна використати MockHonkVerifier як заглушку, поки немає реального circuit v08
- Оператор адреса визначена

**Налаштування `.env`:**

Скопіюй `.env.example` у `.env` і заповни поля. Не комітимо `.env` у репо.

```bash
cp .env.example .env
nano .env
```

**Розгортання:**

```bash
source .env

forge script script/Deploy.s.sol \
  --rpc-url $RPC_URL \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

Прапор `--verify` автоматично надсилає вихідний код на Etherscan для перевірки. Може зайняти 30-60 секунд після розгортання.

---

## Розгортання лише DeviceRegistry

Якщо V3 вже розгорнутий і потрібно замінити лише registry (наприклад, через критичний баг):

```bash
forge script script/DeployDeviceRegistry.s.sol \
  --rpc-url $RPC_URL \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

Після успішного розгортання — викликаємо з адмінського гаманця:

```solidity
v3.setDeviceRegistry(newRegistryAddress);
```

Усі пристрої треба перереєструвати у новому registry — їхні приватні ключі залишаються у HSM ATECC608B пристроїв, реєстрація відбувається через `registerDevice(pubkey, lat, lon)`.

---

## Контрольний список після розгортання у Sepolia

- [ ] Усі адреси контрактів записані у `deployments/sepolia.json`
- [ ] Контракти перевірені на Etherscan (зелений значок Verified)
- [ ] Оператор може викликати `V3.submitProof` для зареєстрованого пристрою (end-to-end тест)
- [ ] План передачі DEFAULT_ADMIN_ROLE з деплоєра на мультипідпис складено
- [ ] Backup приватного ключа деплоєра у безпечному сховищі

---

## Передача адмінства на мультипідпис

Початковий деплоєр має DEFAULT_ADMIN_ROLE одразу після розгортання. Для виробництва це треба передати на Gnosis Safe мультипідпис.

**Кроки (виконуються з акаунта деплоєра):**

1. Створити Gnosis Safe з потрібною конфігурацією підписантів (наприклад 3-з-5)
2. Видати Safe-у роль `DEFAULT_ADMIN_ROLE`:
   ```solidity
   v3.grantRole(v3.DEFAULT_ADMIN_ROLE(), safeAddress);
   registry.grantRole(registry.DEFAULT_ADMIN_ROLE(), safeAddress);
   ```
3. Відмовитись від ролі деплоєра:
   ```solidity
   v3.renounceRole(v3.DEFAULT_ADMIN_ROLE(), deployerAddress);
   registry.renounceRole(registry.DEFAULT_ADMIN_ROLE(), deployerAddress);
   ```

Після цього адмінські дії (`grantRole`, `setVerifier`, `setDeviceRegistry`, pause) виконуються лише через Safe з потрібною кількістю підписів.

**Не виконуй передачу адмінства до того як перевірив що Safe правильно налаштований і має DEFAULT_ADMIN_ROLE — інакше можеш втратити контроль над контрактом.**
