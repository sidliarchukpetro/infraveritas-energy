/**
 * StatisticsModule — historical analysis per-device з TimescaleDB hypertable
 * device_readings_history.
 *
 * Spec: docs/specs/phase4_design.md §7.
 *
 * Provides:
 *   - computeEnergyZScore  — поточна submission's energy normalized vs
 *                            device's rolling history (default 7 days)
 *   - detectDrift          — recent 24h vs 7d baseline shift, indicating
 *                            sensor drift або condition change
 *
 * Cold start handling:
 *   - Z-score returns null якщо < 10 historical samples (statistically
 *     insufficient sample size)
 *   - Drift returns {drift: false, magnitude: 0} якщо baseline window empty
 *     або std deviation === 0
 *
 * Quality filtering:
 *   - Excludes 'divergent' / 'unavailable' rows з baseline — щоб не вчитися
 *     на можливо-фальшивих даних
 *
 * Requires:
 *   - device_readings_history hypertable created (per
 *     aggregator/db/migrations/001_phase4_timescale_init.sql)
 *   - At least one row у table to avoid query plan issues (auto-handled
 *     by cold start logic)
 */

import type { QueryablePool, QueryResultRow } from "./db.js";

// ---------- Public types ----------

export interface DriftSummary {
  /** True якщо recent 24h mean differs from 7d baseline by > threshold std. */
  drift: boolean;
  /** Magnitude wyrażона у standard deviations (0 якщо insufficient data). */
  magnitude: number;
}

// ---------- Internal query row shapes ----------

interface ZScoreRow extends QueryResultRow {
  mean: number | null;
  std: number | null;
  n: string;
}

interface DriftRow extends QueryResultRow {
  recent_mean: number | null;
  baseline_mean: number | null;
  baseline_std: number | null;
}

// ---------- Constants ----------

/** Default historical window for z-score: 7 days. */
const DEFAULT_WINDOW_S = 7 * 24 * 3600;

/** Minimum sample count для statistically valid z-score. */
const MIN_SAMPLES = 10;

/** Z-score threshold for declaring drift (2σ ≈ p < 0.05). */
const DRIFT_THRESHOLD_STD = 2.0;

// ---------- Module ----------

export class StatisticsModule {
  constructor(private readonly pool: QueryablePool) {}

  /**
   * Compute rolling z-score за current submission's energy vs device's history.
   *
   * @param deviceId — target device
   * @param currentEnergyMwh — energy claim з submission, у mWh
   * @param windowSeconds — історичне вікно у секундах (default 7 days)
   * @returns z-score, або null якщо cold start / insufficient variance
   */
  async computeEnergyZScore(
    deviceId: bigint,
    currentEnergyMwh: bigint,
    windowSeconds: number = DEFAULT_WINDOW_S,
  ): Promise<number | null> {
    const windowStart = Math.floor(Date.now() / 1000) - windowSeconds;

    const result = await this.pool.query<ZScoreRow>(
      `SELECT
         AVG(total_energy_mwh)::float AS mean,
         STDDEV(total_energy_mwh)::float AS std,
         COUNT(*)::text AS n
       FROM device_readings_history
       WHERE device_id = $1
         AND submitted_at >= to_timestamp($2)
         AND ensemble_status IN ('ok', 'degraded')`,
      [deviceId.toString(), windowStart],
    );

    const row = result.rows[0];
    if (row === undefined) return null;

    const n = Number(row.n);
    if (
      n < MIN_SAMPLES ||
      row.mean === null ||
      row.std === null ||
      row.std === 0
    ) {
      return null;
    }

    return (Number(currentEnergyMwh) - row.mean) / row.std;
  }

  /**
   * Detect drift — comparison recent 24h mean vs 7d baseline mean.
   * Простий test: magnitude > 2 standard deviations.
   *
   * @param deviceId — target device
   * @returns {drift, magnitude}. drift=false якщо insufficient data
   */
  async detectDrift(deviceId: bigint): Promise<DriftSummary> {
    const result = await this.pool.query<DriftRow>(
      `SELECT
         AVG(total_energy_mwh) FILTER (
           WHERE submitted_at >= NOW() - INTERVAL '24 hours'
         )::float AS recent_mean,
         AVG(total_energy_mwh) FILTER (
           WHERE submitted_at >= NOW() - INTERVAL '7 days'
             AND submitted_at < NOW() - INTERVAL '24 hours'
         )::float AS baseline_mean,
         STDDEV(total_energy_mwh) FILTER (
           WHERE submitted_at >= NOW() - INTERVAL '7 days'
         )::float AS baseline_std
       FROM device_readings_history
       WHERE device_id = $1`,
      [deviceId.toString()],
    );

    const row = result.rows[0];
    if (
      row === undefined ||
      row.recent_mean === null ||
      row.baseline_mean === null ||
      row.baseline_std === null ||
      row.baseline_std === 0
    ) {
      return { drift: false, magnitude: 0 };
    }

    const magnitude = Math.abs(row.recent_mean - row.baseline_mean) / row.baseline_std;
    return { drift: magnitude > DRIFT_THRESHOLD_STD, magnitude };
  }
}
