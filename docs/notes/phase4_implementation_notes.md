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
- Validation default: enabled коли DB configured (через `POSTGRES_*` змінні або legacy `DATABASE_URL`), disabled inakshe
- ~27 секунд end-to-end (proof gen 5s + chain submit 15s + validation persist 7s)
- Один row у `device_readings_history` з ensemble_status, anomaly_flag, chain_submitted=true

3+ critical learnings — записані у memory і future-proofing.

---

## 8. Operational notes (production deployment)

Зафіксовано після першого real-DB smoke test (Тарас, 2026-05-15). Кожен пункт — реальна проблема, виявлена при deployment, та її розв'язок.

### 8.1 Two ways to give aggregator DB credentials

Phase 4 compose (`infra/docker-compose.phase4.yml`) використовує defaults:
- `POSTGRES_USER=infraveritas`
- `POSTGRES_DB=infraveritas_energy`
- `POSTGRES_PASSWORD` — обов'язково з `.env`

**Preferred — окремі змінні середовища** (надійно до будь-яких спецсимволів у паролі):
```
POSTGRES_USER=infraveritas
POSTGRES_PASSWORD=<будь-який пароль, включно з / + @ : тощо>
POSTGRES_HOST=127.0.0.1     # опційно, default 127.0.0.1
POSTGRES_PORT=5432          # опційно, default 5432
POSTGRES_DB=infraveritas_energy  # опційно, default infraveritas_energy
```

Aggregator передає пароль як сирий рядок у `pg.Pool`, без парсингу URL — тому жодних обмежень на символи. Реалізація у `aggregator/src/main.ts::buildPoolConfig()` (commit що додав цю опцію).

**Legacy — `DATABASE_URL`** (зворотна сумісність; пароль має бути URL-safe):
```
DATABASE_URL=postgres://infraveritas:<URL-safe пароль>@127.0.0.1:5432/infraveritas_energy
```

Якщо задані обидва варіанти, aggregator використовує **окремі змінні**.

**Не** `postgres://postgres:postgres@...` — юзера `postgres` у нашій БД не існує, його `psql -U postgres` не пустить.

### 8.2 Password URL-safe requirement (тільки якщо використовуєш DATABASE_URL fallback)

При використанні **окремих змінних** (§8.1 preferred path) — будь-які символи у паролі дозволені.

При використанні `DATABASE_URL` — пароль парситься pg-драйвером як URI. Символи що ламають URL — `/`, `@`, `:`, `?`, `#`, `&`, `+` — **сирими у паролі не можна**.

Безпечні генератори (для DATABASE_URL шляху):
- ✅ hex: `openssl rand -hex 32` → 64 chars, тільки `[0-9a-f]`
- ✅ url-safe base64: `python -c 'import secrets, base64; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("="))'`
- ❌ `openssl rand -base64 32` — генерує `+`, `/`, `=` (зустрічається `/` → ламає URL)

**Симптом** коли password містить непідходящий символ і використовується DATABASE_URL:
- startup лог: `validation: "enabled"` (виглядає правильно)
- при submission: `event: "validation-failed", err: "Invalid URL"`
- hypertable: порожня (persistence не виконалась)
- chain submission: пройшов (worker submit не залежить від DB)

**Найпростіша рекомендація:** використовуй §8.1 preferred path — і проблема не виникне взагалі.

### 8.3 Working compose recipe (Windows)

`docker-compose.yml` у корені репо **не існує** — основний у `aggregator/docker-compose.yml`. Робоча команда з кореня репо:

```bash
docker compose --env-file .env \
  -f aggregator/docker-compose.yml \
  -f infra/docker-compose.phase4.yml \
  up -d postgres
```

Ключове:
- `--env-file .env` **обов'язковий** — без нього docker compose шукає `.env` поряд з першим `-f` файлом (у `aggregator/`), не у корені репо
- `.env` має бути **без BOM** — Windows PowerShell `Set-Content -Encoding UTF8` додає BOM, який ламає парсинг першого рядка змінних. Писати через ASCII або `.NET WriteAllText` з UTF-8 без BOM
- Окремий `-f infra/docker-compose.phase4.yml` **БЕЗ** base aggregator compose не працює (overlay потребує base)

### 8.4 Verification queries

З правильними credentials:
```bash
docker exec infraveritas-postgres psql -U infraveritas -d infraveritas_energy \
  -c "\d device_readings_history"
# Expected: 18 columns + 5 indexes

docker exec infraveritas-postgres psql -U infraveritas -d infraveritas_energy \
  -c "SELECT hypertable_name FROM timescaledb_information.hypertables;"
# Expected: device_readings_history (1 row)
```

### 8.5 Smoke test gotchas

- `edge/scripts/sepolia_smoke.py` тепер приймає `--epoch-start-ts <unix_seconds>` (за замовчуванням — поточний час). Без цього після першого успішного E2E `lastSubmissionTimestamp` на V3 фіксує epoch, і наступні запуски з тим самим значенням revert-ять `InvalidTimestamp`.
- Локальний `edge/edge-test-key.pem` на кожній машині генерує **окрему** пару P-256 ключів. Перед smoke-тестом перевір `isAuthorized` у DeviceRegistry для свого pubkey — якщо ні, зареєструй (script сам виведе готову `cast send` команду у разі `DeviceNotActive`).

### 8.6 Weather APIs — degraded status is common

`ensemble_status='degraded'` (тільки 1 з 3 providers responded) — нормальна поведінка на free tier. NASA POWER і PVGIS мають load обмеження для unauthenticated traffic. У production:

- Якщо багато submissions з `degraded` — додати retry logic або зареєструватись для API keys
- `unavailable` (всі 3 fail) — варто alert ops, але submission все одно проходить на chain
