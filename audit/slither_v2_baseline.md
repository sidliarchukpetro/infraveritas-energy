# Slither V2 Baseline

**Дата:** 12 травня 2026
**Версія Slither:** 0.11.5
**Аналізований файл:** `contracts/src/EnergyProofRegistry.sol`
**Foundry build:** Solc 0.8.28, optimizer (200 runs), evm cancun
**V2 deployed адреса (Sepolia):** 0x28a69803fE9da4Fb019B93C8a584F639a8fCAFCb
**Виявлено findings:** 3

## Контекст аналізу

`HonkVerifier.sol` і `HonkVerifierV07Spike.sol` виключено через відомий Slither bug при парсингу auto-generated cryptographic constants (AssertionError у constants_folding.py). Це проблема Slither з Aztec generated verifier, не нашого коду. Фокус на наш реальний контракт EnergyProofRegistry.

## Findings

### F-001: incorrect-equality (LOW)

**Файл:** EnergyProofRegistry.sol:125
**Код:** `lastEpochTimestamp[deviceId] == 0`

Slither flag-ить strict equality з нулем. У нашому контексті — перевірка "пристрій ніколи не submit-ив" — стандартний pattern для unset entry в mapping (де 0 — default).

**Вердикт:** false positive
**Дія:** none. Зберігаємо у V3.

### F-002: events-access (MEDIUM)

**Файл:** EnergyProofRegistry.sol:148-151
**Функція:** transferOwnership(address)

Зміна owner не emit event. Реальна проблема — off-chain monitoring не бачить зміни.

**Вердикт:** legitimate
**Дія:** виправити у V3. Заміна власної ownership на OpenZeppelin AccessControl автоматично додасть emit RoleGranted/RoleRevoked. V2 не патчимо — переписуємо у V3.

### F-003: timestamp (LOW)

**Файл:** EnergyProofRegistry.sol:124-127
**Функція:** isOnline(uint256)

Використання block.timestamp у порівнянні. Slither warning про маніпуляцію валідаторами (~15с).

**Вердикт:** false positive
**Обґрунтування:** ONLINE_TIMEOUT за дизайном кілька годин, validator-влив на 15с не змінює результат isOnline.
**Watchpoint:** якщо у V3 ONLINE_TIMEOUT зменшиться до значення менше за хвилину — переоцінити.

## Підсумок

| Severity | Кількість | False positives | Legitimate |
|----------|-----------|-----------------|------------|
| HIGH     | 0         | 0               | 0          |
| MEDIUM   | 1         | 0               | 1          |
| LOW      | 2         | 2               | 0          |

**Дії перед V3:**
- F-002: OpenZeppelin AccessControl замість власної ownership (автоматичні events)

**Не виправляємо у V2:** V2 deployed на Sepolia, правки у V3 переписуванні.
