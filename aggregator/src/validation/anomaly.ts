/**
 * AnomalyEvaluator — комбінує ensemble result, statistics, і payload metadata
 * у простий boolean-flag score.
 *
 * Spec: docs/specs/phase4_design.md §8.
 *
 * Design rules:
 *   - Flags boolean, не numeric — простіше пояснити, простіше debug
 *   - reviewRequired — інформаційний flag для post-hoc audit; НЕ блокує chain submit
 *   - High-severity flags заслуговують додаткової уваги operator-а
 *
 * Anomaly types:
 *   tamper_flag_set                  — фізичний tamper detected на edge
 *   divergent_weather_sources        — providers не згодні (≥ threshold)
 *   weather_unavailable              — всі 3 weather APIs failed
 *   energy_inconsistent_with_weather — нічна генерація / неможливі значення
 *   energy_zscore_high               — outlier vs device's own history
 *   drift_detected                   — device's baseline shifted
 */

import type { EnsembleResult } from "./weather/ensemble.js";
import type { DriftSummary } from "./statistics.js";

// DriftSummary defined у statistics.ts (де він виробляється);
// re-exported тут для backward compat і convenience для callers що уже
// імпортують з anomaly.js
export type { DriftSummary } from "./statistics.js";

// ---------- Types ----------

export type AnomalyFlag =
  | "energy_inconsistent_with_weather"
  | "energy_zscore_high"
  | "divergent_weather_sources"
  | "weather_unavailable"
  | "drift_detected"
  | "tamper_flag_set";

/**
 * Підмножина payload's у форматі, потрібному для anomaly evaluation.
 * Окремий тип щоб не залежати від CanonicalPayload з verify/canonical.ts —
 * AnomalyEvaluator не повинен знати про повний payload shape.
 */
export interface AnomalyInputPayload {
  tamper_flag: bigint;
  total_energy_mwh: bigint;
}

export interface AnomalyResult {
  /** Всі flags які спрацювали. Порожній масив = "clean" submission. */
  flags: AnomalyFlag[];
  /**
   * True якщо хоч один high-severity flag спрацював.
   * Не блокує chain submit — це інформаційний signal для operator review.
   */
  reviewRequired: boolean;
}

// ---------- Thresholds (могут бути tuned пізніше) ----------

const HIGH_SEVERITY: AnomalyFlag[] = [
  "energy_inconsistent_with_weather",
  "tamper_flag_set",
];

/** GHI < цього порогу → нічно/темно. */
const NIGHT_GHI_THRESHOLD = 10; // W/m²

/** Energy claim > цього при темному GHI → flag inconsistency. */
const NIGHT_ENERGY_THRESHOLD = 100n; // mWh — невелика tolerance для noise

/** |z| > цього → outlier vs device history. */
const ZSCORE_OUTLIER_THRESHOLD = 3.0;

// ---------- Main ----------

export function evaluateAnomaly(
  payload: AnomalyInputPayload,
  ensemble: EnsembleResult,
  zscore: number | null,
  drift: DriftSummary,
): AnomalyResult {
  const flags: AnomalyFlag[] = [];

  // 1. Tamper flag — direct з payload
  if (payload.tamper_flag !== 0n) {
    flags.push("tamper_flag_set");
  }

  // 2. Weather source status
  if (ensemble.status === "divergent") {
    flags.push("divergent_weather_sources");
  } else if (ensemble.status === "unavailable") {
    flags.push("weather_unavailable");
  }

  // 3. Energy consistency з ensemble — heuristic.
  // Тільки коли є trustable ensemble (ok або degraded). Якщо providers самі
  // розходяться — не довіряємо ensemble.ghi для cross-check.
  if (ensemble.status === "ok" || ensemble.status === "degraded") {
    // Нічна генерація: ensemble каже темно, але device claims significant energy
    if (
      ensemble.ghi < NIGHT_GHI_THRESHOLD &&
      payload.total_energy_mwh > NIGHT_ENERGY_THRESHOLD
    ) {
      flags.push("energy_inconsistent_with_weather");
    }
    // Inverse case (sunny + zero energy) поки не flag — legitimate причини
    // (брудна панель, тінь, owner вимкнув). Для пост-MVP detailed checks.
  }

  // 4. Statistical outlier — z-score
  if (zscore !== null && Math.abs(zscore) > ZSCORE_OUTLIER_THRESHOLD) {
    flags.push("energy_zscore_high");
  }

  // 5. Long-term drift
  if (drift.drift) {
    flags.push("drift_detected");
  }

  return {
    flags,
    reviewRequired: flags.some((f) => HIGH_SEVERITY.includes(f)),
  };
}
