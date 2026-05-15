# Phase 4 — Implementation Notes

*Written 2026-05-15, post compute+DB layer completion*
*Scope: cross-validation з external reality (architectural Phase 4 / 8-phase roadmap)*

---

## 1. Status snapshot

| Sub-step | Що | Стан | Commit |
|---|---|---|---|
| Week 1 | OpenMeteoProvider + IrradianceProvider interface + Timescale schema | ✅ | `3a93159` |
| Week 2 | NASAPowerProvider + PVGISProvider | ✅ | `43ee459` → fix `3d5121d` |
| Week 3 | EnsembleProvider (median + std + status) | ✅ | `fa8d68c` |
| Week 4a | AnomalyEvaluator (pure function) | ✅ | `fa8d68c` (same commit) |
| Week 4b | StatisticsModule + SubmissionPersistence + db.ts | ✅ | `b97b1d3` |
| Week 4c-1 | ValidationPipeline orchestrator | ✅ | `4aed8ea` → fix (TBD) |
| **Week 4c-2** | **Worker integration + main.ts wiring + pg dependency** | ⏳ блокується Тарасом (Postgres setup) | — |

**Tests passing:** 176 (всі unit + 2 integration suites).
**CI:** Зелений на main після hotfix `c-1`.
**Coverage:** compute layer ~95%, persistence ~85%, pipeline orchestration ~90%.

---

## 2. Architectural deviations від initial design

Документ `docs/specs/phase4_design.md` написаний на старті Phase 4 з ідеалізованими припущеннями. Реальність змінила деякі рішення.

### 2.1 DriftSummary location — moved

**Initial:** Тип визначався у `anomaly.ts` бо це anomaly input.
**Реальність:** Виробляється у `StatisticsModule.detectDrift()`. Producer-defines-type pattern → переміщено у `statistics.ts`. `anomaly.ts` re-exports для backward compat:

```typescript
// anomaly.ts
export type { DriftSummary } from "./statistics.js";
```

Один import-сайт у `anomaly.ts`, нуль зломаних callers.

### 2.2 ValidationPipeline — not у original plan

**Initial design §10:** "Worker безпосередньо вкликає ensemble, statistics, anomaly, persistence у фіксованому порядку."

**Реальність:** Введено клас `ValidationPipeline` як orchestrator. Worker отримує його як optional dependency у constructor, викликає `pipeline.process(payload, totalEnergyMwh, options?)`. Один публічний метод.

Причини:
- Worker tests залишаються незмінними коли `validationPipeline === undefined` (existing behavior)
- Production wiring у main.ts — інстанціюється тільки коли `DATABASE_URL` задана
- Easier to mock у unit tests — одна dependency замість чотирьох
- Чіткіше separation of concerns: worker = proof gen + chain submit; pipeline = validation flow

### 2.3 db.ts — local types pattern

**Initial:** `pg.Pool` як direct dependency у `statistics.ts`, `persistence.ts`.

**Реальність:** Створено `db.ts` з мінімальними local interfaces:

```typescript
export interface QueryablePool {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}
```

Реальний `pg.Pool` satisfies цей interface automatically через structural typing. Переваги:
1. Source code не імпортує `pg` — швидший compile, менший test bundle
2. Tests працюють на `vi.fn()` mocks без `pg` installed
3. Swappable drivers (postgres-js, тощо) без changes у validation/

Trade-off: production main.ts мусить імпортувати реальний `pg.Pool` і передавати у constructors. Це додає `pg` як dependency тільки у одному файлі (entrypoint).

### 2.4 totalEnergyMwh — explicit parameter

**Initial:** Припускалось що `payload.total_energy_mwh` доступне на `CanonicalPayload`.

**Реальність:** `CanonicalPayload` НЕ містить `total_energy_mwh` — це computed public input до ZK circuit, обчислюється aggregator-ом з readings (sum voltage_mv × current_ma × interval). Public input до Honk verifier, але **не payload field**.

Fix: `ValidationPipeline.process(payload, totalEnergyMwh, options?)` приймає це як explicit param. Worker уже обчислює це для chain submit, передає у pipeline без дублювання логіки.

**Bug surfaced двічі** — у тиждень 4c-1, бо vitest пройшов (esbuild transpilує без type-check), а `tsc -p tsconfig.build.json` (CI build job) fail.

---

## 3. Critical learnings

### 3.1 vitest passing ≠ CI passing

Aggregator `tsconfig.build.json` має `include: ["src/**/*.ts"]` і `exclude: ["tests", "**/*.test.ts"]`. Це означає:
- `tsc` (CI build job) перевіряє тільки `src/` — strict mode lookcis там
- vitest використовує esbuild on-the-fly — transpile без type-check
- Тести можуть мати invalid types але runtime OK → проходять
- src/ з invalid types → `tsc` fail у CI, vitest passing

**Implication:** Strict-mode self-check перед drop ОБОВ'ЯЗКОВО на src/ files. Test files можна писати з менш строгим перевіренням, але src/ — completely strict.

### 3.2 `noUncheckedIndexedAccess` — невидимий killer

Тричі поспіль fix bouncing через цей flag у тижнях 2, 3, 4c-1:
- `keys[0]` returns `T | undefined`, не `T`
- Regex match groups після destructure — кожна `string | undefined`
- Array map з index `arr[i]` потребує narrow

Patterns які працюють:
```typescript
// Pattern 1: explicit undefined tracking + throw guard
let closestKey: string | undefined = undefined;
// ... loop ...
if (closestKey === undefined) throw new Error(...);
const value = series[closestKey];

// Pattern 2: paired data (зберігаємо разом замість separate access)
this.providers.map(async (p) => ({ name: p.name, point: await p.fetch(...) }))

// Pattern 3: nullish coalescing з fallback
return mid ?? 0;

// Pattern 4: explicit check на destructured values
const [, yyyy, mm] = match;
if (yyyy === undefined || mm === undefined) return null;
```

### 3.3 Compute-layer-first без integration — це OK

Спочатку було побоювання що писати compute modules без real production wiring — це dead code. Реальність: тиждні 1-4c-1 = 6 модулів повністю протестовані на mocks/HTTP fixtures, **жоден** не require real DB або real worker.

Перевага — week 4c-2 (worker integration) буде малою, low-risk зміною. Усе compute knowledge encapsulated у standalone modules. Worker просто додасть один if-block.

---

## 4. File inventory після Phase 4 compute+DB layer

```
aggregator/src/validation/
├── db.ts                    # QueryablePool interface (33 рядки)
├── statistics.ts            # StatisticsModule + DriftSummary (153)
├── persistence.ts           # SubmissionPersistence (111)
├── anomaly.ts               # AnomalyEvaluator + DriftSummary re-export (126)
├── pipeline.ts              # ValidationPipeline orchestrator (133)
└── weather/
    ├── provider.ts          # IrradianceProvider interface + ProviderError
    ├── openMeteo.ts         # OpenMeteoProvider
    ├── nasaPower.ts         # NASAPowerProvider
    ├── pvgis.ts             # PVGISProvider
    └── ensemble.ts          # EnsembleProvider (208 рядків, з усіма strict mode fixes)

aggregator/tests/unit/validation/
├── statistics.test.ts       # 23 tests
├── persistence.test.ts      # 17 tests
├── anomaly.test.ts          # 23 tests
├── pipeline.test.ts         # 15 tests
└── weather/
    ├── openMeteo.test.ts    # 20 tests
    ├── nasaPower.test.ts    # 17 tests
    ├── pvgis.test.ts        # 19 tests
    └── ensemble.test.ts     # 19 tests

aggregator/db/migrations/
└── 001_phase4_timescale_init.sql   # device_readings_history hypertable

infra/
└── docker-compose.phase4.yml       # TimescaleDB service
```

Total: ~1700 рядків source + ~2400 рядків tests = ~4100 рядків з Phase 4 (без integration tests).

---

## 5. Що залишилось — week 4c-2

Worker integration. Це modify-existing-files drop, не нові файли.

### 5.1 Files to modify

| File | Зміна |
|---|---|
| `aggregator/src/worker/index.ts` | Constructor — optional `validationPipeline?: ValidationPipeline`. Виклик `pipeline.process()` після proof gen, **best-effort** (try/catch, не блокує chain submit) |
| `aggregator/src/main.ts` | Якщо `DATABASE_URL` set — instantiate `pg.Pool`, всі validators, ValidationPipeline; pass у worker. Інакше — worker отримує undefined |
| `aggregator/package.json` | Add `pg` + `@types/pg` dependencies |
| `aggregator/src/server.ts` (або equivalent з API routes) | Update `GET /submissions/:id` response shape — додати `validation` field з `outcome` |
| `aggregator/tests/integration/api.test.ts` | Update existing assertions якщо response shape change ламає |
| `infra/docker-compose.phase4.yml` | Aggregator service depends_on postgres |

### 5.2 Blocking

Тарас має підтвердити:
1. `docker compose -f infra/docker-compose.phase4.yml up postgres` стартує
2. Migration `001_phase4_timescale_init.sql` запускається без error
3. `device_readings_history` hypertable створена (`SELECT * FROM timescaledb_information.hypertables WHERE hypertable_name = 'device_readings_history'`)

Без цього week 4c-2 пишеться "blind" — нема як перевірити production wiring.

### 5.3 Non-blocking preparation (можна робити паралельно)

- Update `phase4_design.md` з виправленими специфіками (DriftSummary location, ValidationPipeline pattern, тощо)
- Прочитати поточний `worker/index.ts` і `main.ts` (для точного patch на week 4c-2)

---

## 6. Open questions для Олександра (review queue)

Чекає consultant/auditor review:

1. **Anomaly thresholds** — `NIGHT_GHI_THRESHOLD=10 W/m²`, `NIGHT_ENERGY_THRESHOLD=100 mWh`, `ZSCORE_OUTLIER_THRESHOLD=3.0`, `DRIFT_THRESHOLD_STD=2.0`. Чи розумні для solar use case? Calibration TBD з real data.
2. **Strict-3-of-3 vs degraded-1-of-3** — поточно ensemble.status='ok' потребує всіх 3, 'degraded' дозволяє 1+. Це permissive — чи безпечно?
3. **`reviewRequired` semantics** — інформаційний flag, не блокує chain submit. Це навмисно (per design доку §8). Чи погоджуєшся з compromise?
4. **DriftSummary у statistics.ts vs anomaly.ts** — це невелике rearrangement; чи варто переробляти interfaces у v2 коли буде domain stabilization?
5. **db.ts local types** — clean separation, але дублює мінімально якщо `pg.Pool` зміниться. Чи переходити на direct `pg` import якщо staying on pg long-term?
6. **Best-effort persistence у worker** — якщо persistence throw, submission продовжує без trace у hypertable. Це втрата observability. Чи варто стратегію — fail submission якщо persistence fail (atomic)?

---

## 7. Сумарно (станом на 2026-05-15 17:36 UTC)

Phase 4 architectural — **FULLY CLOSED**. Real Sepolia + Postgres end-to-end працює. Тарас підтвердив у власній environment, commit `4381da0`:

- Pipeline: edge → aggregator → V3 (Sepolia) → 3 weather APIs → statistics → TimescaleDB hypertable
- Validation default: enabled коли DATABASE_URL set, disabled inakshe
- ~27 секунд end-to-end (proof gen 5s + chain submit 15s + validation persist 7s)
- Один row у `device_readings_history` з ensemble_status, anomaly_flag, chain_submitted=true

3+ critical learnings — записані у memory і future-proofing.

---

## 8. Operational notes (production deployment)

Через real-DB smoke test (Тарас, 2026-05-15) виявлено кілька operational quirks які треба знати при deployment.

### 8.1 Deployment recipe — start Postgres + aggregator

Compose файли потрібно merge — base у `aggregator/`, Phase 4 overlay у `infra/`:

```bash
docker compose --env-file .env \
  -f aggregator/docker-compose.yml \
  -f infra/docker-compose.phase4.yml \
  up -d postgres
```

Окремий `-f infra/docker-compose.phase4.yml` БЕЗ base aggregator compose не працює.

### 8.2 DATABASE_URL pattern

Compose defaults: `POSTGRES_USER=infraveritas`, `POSTGRES_DB=infraveritas_energy` (НЕ стандартний `postgres:postgres@.../postgres`).

Connection URL pattern:

```
DATABASE_URL=postgres://infraveritas:<password>@127.0.0.1:5432/infraveritas_energy
```

### 8.3 POSTGRES_PASSWORD requirement — URL-safe characters only

Поточна архітектура — `new Pool({connectionString})` з URL string. Це ламається коли password містить символи `/` або `+` (типові у standard base64). Помилка: `validation-failed err: "Invalid URL"` runtime.

**Вимога:** POSTGRES_PASSWORD повинен бути **URL-safe**. Безпечні варіанти:

- Hex (`openssl rand -hex 32`)
- base64url (без padding) — варіант base64 з `-_` замість `+/`

**Backlog refactor (post-MVP):** перевести `new Pool({user, password, host, database, port})` form замість URL string — robust до будь-яких password chars.

### 8.4 Sepolia smoke test — known issue

`edge/scripts/sepolia_smoke.py` має hardcoded `epoch_start_ts=1_778_000_000`. Після першого успішного run V3.lastSubmissionTimestamp = це значення; всі наступні runs reverт InvalidTimestamp (V3 enforces monotonic timestamps).

**Workaround:** manual patch на `int(time.time())` перед re-run.

**TODO:** додати CLI flag `--epoch-start-ts` або default до `time.time()`. Tracked у issue [TBD].

### 8.5 Weather APIs — degraded status is common

`ensemble_status='degraded'` (тільки 1 з 3 providers responded) — нормальна поведінка на free tier. NASA POWER і PVGIS мають load обмеження для unauthenticated traffic. У production:

- Якщо багато submissions з `degraded` — додати retry logic або зареєструватись для API keys
- `unavailable` (всі 3 fail) — варто alert ops, але submission все одно проходить на chain
