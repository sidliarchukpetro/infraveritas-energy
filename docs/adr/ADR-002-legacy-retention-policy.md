# ADR-002: Legacy code retention policy

**Status:** Accepted
**Date:** 12 травня 2026
**Related:** v1.4 MVP Plan, ADR-001 v2 architecture (blake2s)

## Context

InfraVeritas Energy має значний обсяг попередньо написаного коду: V2 контракти deployed на Sepolia, ZK circuits v05/v06/v07_spike, Aggregator V1 на SQLite, edge mock на Python з software signing. Плану v1.4 передбачає переписування всього цього у Етапах 2-7.

Питання: що робити зі старим кодом перш ніж писати новий?

Розглянуті варіанти:
1. **Видалити** — чистий старт, але втрачаємо reference і документований стан того що deployed
2. **Залишити у main path папках** — створює false signal "це актуальний код" і ризик "малих компромісів" типу "додамо gap-checking у V2 замість писати V3"
3. **Перенести у legacy/ з явним маркуванням** — зберігаємо baseline, видаляємо ризик повторення обмежень

## Decision

Прийнятий варіант 3. Всі попередньо написані компоненти у `legacy/` підпапках:

| Компонент | Шлях | Статус |
|---|---|---|
| V2 контракти | `contracts/legacy/v2/` | deployed Sepolia: 0x28a69803... |
| ZK v05/v06/v07_spike | `zk/circuits/legacy/` | v06 deployed: 0xe8E70bF... |
| Aggregator V1 | `aggregator/legacy/v1/` | working на машині Petro |
| Edge mock | `edge/legacy/edge_device_v1.py` | Python software signing |

Кожна legacy папка містить README з посиланнями на v1.4 Plan і відповідні етапи переписування.

Нові версії у "main path":
- V3 → `contracts/src/` (Етап 2)
- ZK v08 → `zk/circuits/v08/` (Етап 3)
- HAL → `edge/hal/` (Етап 4)
- Aggregator V2 → `aggregator/src/` (Етап 5)

## Consequences

**Плюси:** чітке розмежування виключає випадкове використання старого; baseline Slither/Aggregator audit залишається як reference; V1 продовжує приймати submissions на Sepolia під час розробки V2.

**Мінуси:** більший repo size; новачку (Тарас) треба disciplined читання README щоб не плутати legacy і main.

**Mitigation:** generated artifacts (target/, out/, *.log) виключені через .gitignore; CI явно вказує legacy/v2 шлях для Slither; при V3 design — TODO comments посилаються на конкретні legacy findings (наприклад F-002 у audit/slither_v2_baseline.md).

## When this ADR can be revisited

- Коли всі Етапи 2-7 завершені (тиждень 27) — перегляд чи legacy ще потрібен
- Якщо V2 на Sepolia формально deprecated → можна видалити legacy/v2/
- Після MVP review
