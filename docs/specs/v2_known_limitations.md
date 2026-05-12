# V2 known limitations (checklist для V3 design)

**Дата:** 12 травня 2026

Це чек-лист коли пишемо V3 (Етап 2). Кожне обмеження V2 повинно бути або вирішене у V3, або свідомо залишене з обґрунтуванням.

## Контрактні обмеження V2

**L-001:** Власна ownership без emit events (F-002 у Slither baseline, medium severity). У V3 переходимо на OpenZeppelin AccessControl з автоматичними RoleGranted і RoleRevoked events.

**L-002:** Без Pausable. Контракт V2 неможливо зупинити при incident. У V3 додаємо OpenZeppelin Pausable, owner може викликати pause() для зупинки нових submissions; існуючі дані залишаються.

**L-003:** Без ReentrancyGuard. Функції що змінюють state не захищені (поточно не критично у V2 бо немає external calls, але для production-safety необхідно). У V3 додаємо OpenZeppelin ReentrancyGuard на submitProof і будь-яких функціях з потенційним external call.

**L-004:** Без gap-checking. V2 не відстежує розриви між submissions. У V3 додаємо mapping deviceId до lastTimestamp, при різниці більше 48 годин emit event з postDisconnection true. Aggregator робить посилену історичну перевірку для таких submissions.

**L-005:** Без DeviceRegistry. У V2 будь-який валідний підпис з будь-яким deviceId приймається. У V3 створюємо окремий DeviceRegistry контракт, submitProof перевіряє isRegistered(deviceId), revert якщо false.

**L-006:** Тільки secp256k1. V2 verify.ts через @noble/curves для secp256k1, але ATECC608B (планується у Етапі 4b) працює на secp256r1. У V3 додаємо P256Verifier wrapper контракт, EnergyProofRegistry вибирає verifier за signatureScheme поле у submission.

## ZK обмеження v06

**Z-001:** Hash покриває тільки readings, не повний payload (timestamps, GPS, deviceId не входять у hash). У v08 переходимо на full canonical hash через blake2s, що унеможливлює заміну metadata без re-proving.

**Z-002:** Soundness формально не перевірений. v06 deployed і приймає proofs, але формального аудиту constraints не було. Pre-Етап 3 task: формальний review v06 constraints у документі zk_v06_review.md перед написанням v08.

## Edge обмеження V1

**E-001:** Software signing, ключ secp256k1 у файлі на диску. Крадіжка Pi означає копію ключа. У Етапі 4b переходимо на ATECC608B HSM, ключ генерується у чіпі і ніколи не виходить назовні.

**E-002:** Час від системних годинників Pi. Pi може фальсифікувати timestamp, що зриває перехресну валідацію з weather ensemble. У Етапі 4b додаємо GPS NEO-6M, timestamp береться з атомних годинників супутників.

**E-003:** Без локального накопичення. При offline submissions губляться. У Етапі 4 додаємо SQLite на SD картці з GPS timestamps, при відновленні зв'язку відправляємо поодинці з оригінальними timestamps.

**E-004:** Без tamper detection. Відкриття корпусу не виявляється. У Етапі 4b додаємо два магнітні геркони, при відкритті tamperFlag стає 1 у всіх наступних submissions.

**E-005:** AC-side PZEM вимірювання. Вразливо до атаки "купив дешеву нічну електрику з мережі, продаю як сонячну". У Етапі 4b PZEM переноситься на DC сторону панелі, що фізично унеможливлює подачу з мережі у DC коло.

## Aggregator обмеження V1

**A-001:** SQLite single-file lock. При concurrent writes файлове блокування блокує продуктивність. У Етапі 5 переходимо на PostgreSQL з TimescaleDB extension.

**A-002:** Subprocess calls у main thread Express. Signature verify, ZK proof verify, chain submission - все блокує main thread. У Етапі 5 виділяємо BullMQ worker pool на Redis з окремими workers.

**A-003:** Без mTLS edge-aggregator. Server-side TLS, edge може бути будь-хто з network access. У Етапі 5 додаємо mTLS з внутрішньою CA, кожен edge має cert у ATECC slot 1.

**A-004:** Solcast як single weather dependency. Комерційний API, єдина точка відмови для trust layer. У Етапі 6 переходимо на ensemble Open-Meteo plus NASA POWER plus PVGIS, розходження між трьома джерелами стає сам по собі сигналом аномалії.

## Threat model gaps

З 38 атак у Explanatory Note v1.0 не закриті у поточному V1/V2:

- Нічна генерація через мережу — потребує DC PZEM plus gap-checking plus ensemble historical.
- Крадіжка Pi у нове місце — потребує GPS координати plus DeviceRegistry перевірку.
- Відключи інтернет, маніпулюй пристроєм, надішли заднім числом — потребує gap-checking plus ensemble historical plus tamper switches.
- Підміна координат у submission — потребує GPS hardware і перевірку у DeviceRegistry.
- Відкриття корпусу і фізична маніпуляція — потребує tamper switches.

Повний 38-attack mapping реалізовується як автоматизований test suite у Етапі 7.

## Чек-лист для V3 design

При написанні V3 контракту перевірити:

- L-001 до L-006 — кожне обмеження адресовано у V3 коді або обґрунтовано чому пропущено.
- V3 проходить Slither без medium severity findings (F-002 закритий через OZ AccessControl).
- Foundry test coverage для нових функцій мінімум 80% (gap-checking, AccessControl interactions, DeviceRegistry integration).
- Gas costs порівняння V2 проти V3 у документі — без значного зростання витрат на submitProof.
- Backward compatibility з V2 deployed на Sepolia не обов'язкова бо це testnet.

## Перегляд документа

Цей документ перевіряється після написання V3 на Етапі 2 review. Кожне обмеження НЕ адресоване у V3 додається у backlog з обґрунтуванням.
