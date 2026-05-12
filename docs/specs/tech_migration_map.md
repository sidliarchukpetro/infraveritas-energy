# Технологічна карта міграції v1.3 до v1.4

**Дата:** 12 травня 2026

Зведення основних змін архітектури і компонентів. Деталі у v1.4 MVP Plan.

## Контракти

V2 (Hardhat) перетворюємо на V3 (Foundry плюс OpenZeppelin): AccessControl з emit events, Pausable, ReentrancyGuard, gap-checking (mapping deviceId до lastTimestamp, MAX_GAP 48 годин), DeviceRegistry як окремий контракт, P256Verifier wrapper для secp256r1. Етап 2.

## ZK schema

v06 (hash покриває тільки readings, deployed Sepolia) перетворюємо на v08 (повний canonical hash через blake2s, підтримка secp256k1 і secp256r1). Етап 3. Pre-work: формальний soundness review v06 constraints перед написанням v08.

## Edge-пристрій

Python mock з software signing перетворюємо на HAL: MockEdgeDevice у Етапі 4a (software-first до прибуття заліза), RaspberryPiEdgeDevice у Етапі 4b (з реальним залізом).

Hardware у фінальній конфігурації: ATECC608B HSM (secp256r1, ключ ніколи не покидає чіп), GPS NEO-6M (координати і час від атомних годинників супутників), два магнітні геркони для tamper detection через GPIO, DC-side PZEM-016 (фізично унеможливлює подачу з мережі у DC коло), SQLite на SD картці для offline-періодів з GPS timestamps.

Виключено з архітектури v1.4: BH1750 датчик світла (weather ensemble замість локального датчика).

## Aggregator

V1 (SQLite plus Express plus secp256k1 у main thread) перетворюємо на V2 (Етап 5): PostgreSQL з TimescaleDB extension, BullMQ worker pool на Redis, mTLS з внутрішньою CA (edge cert зберігається у ATECC slot 1).

## Weather провайдери

Solcast (комерційний API, до 15000 доларів на місяць на масштабі) замінено на ensemble Open-Meteo плюс NASA POWER плюс PVGIS (всі безкоштовні, redundancy між трьома незалежними джерелами). Етап 6. OpenWeather як fallback виключено бо ensemble має внутрішню redundancy.

## Безпека post-MVP

Після інвестицій: Gnosis Safe мультипідпис 3-з-5, OpenZeppelin TimelockController з 48-72h delay, Immunefi bug bounty програма, OperatorRegistry SBT з KYC для операторів.

## Виключено з v1.4 стратегічно

TDD сервіс для ECSP платформ (раніше планувалось як cashflow, тепер всі ресурси на MVP).
USPTO utility patent (бюрократія, не критичний шлях).
Активний outreach до партнерів (тиша до тижня 27 коли є робочий MVP).

## Етапи проекту

Етап 1 (тижні 1-2): чесний базис — Foundry, OpenZeppelin, Slither baseline, GitHub Actions CI. Стан: завершено.

Етап 2 (тижні 3-7): V3 контракт з gap-checking і OpenZeppelin. Наступне.

Етап 3 (тижні 8-11): ZK v08, DeviceRegistry, P256Verifier. Чекає Етапу 2.

Етап 4a (паралельно 1-6): HAL plus MockEdgeDevice у симуляції. Можемо починати паралельно.

Етап 4b (після прибуття заліза, очікувано 4 тижні): RaspberryPiEdgeDevice з реальним hardware.

Етап 5 (тижні 16-19): Aggregator V2 на PostgreSQL, BullMQ, mTLS.

Етап 6 (тижні 20-24): weather ensemble plus статистика per-device.

Етап 7 (тижні 25-27): The Graph subgraph plus публічний dashboard. MVP досягнуто.

## Оновлення документа

Оновлюється коли: етап завершений, рішення змінилось, додано новий компонент. Будь-яка зміна йде через PR з обґрунтуванням у commit message.
