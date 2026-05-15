/**
 * SubmissionPersistence — пише результат submission+validation у
 * TimescaleDB hypertable device_readings_history.
 *
 * Spec: docs/specs/phase4_design.md §6 + §10.
 *
 * Single responsibility — INSERT. Updates (наприклад, для tx_hash backfill
 * після chain submit) — окремий метод позже якщо знадобиться.
 *
 * Encoding rules:
 *   - bigint fields → decimal strings (Postgres BIGINT приймає strings via node-pg)
 *   - Optional fields (stdDev, relativeDivergence) → null коли undefined
 *   - perProvider serialized as JSON string for JSONB column
 *   - anomaly.flags → JS array (node-pg maps на Postgres text[])
 *   - submitted_to_chain derived з txHash presence
 */

import type { QueryablePool } from "./db.js";
import type { EnsembleResult } from "./weather/ensemble.js";
import type { AnomalyResult } from "./anomaly.js";

// ---------- Input type ----------

export interface PersistInput {
  /** When aggregator received submission (UTC). */
  submittedAt: Date;
  deviceId: bigint;
  sessionId: bigint;

  /** Spatial coords scaled by 1e7 (from payload). */
  latE7: bigint;
  lonE7: bigint;

  /** Claims from payload. */
  epochStartTs: bigint;
  totalEnergyMwh: bigint;

  /** Cross-validation result з EnsembleProvider. */
  ensemble: EnsembleResult;

  /** Statistics — null if cold start. */
  energyZscore: number | null;

  /** Anomaly evaluation. */
  anomaly: AnomalyResult;

  /** Chain references (filled after submitProof). */
  sessionKey?: Uint8Array;
  txHash?: Uint8Array;
}

// ---------- Module ----------

export class SubmissionPersistence {
  constructor(private readonly pool: QueryablePool) {}

  async persist(input: PersistInput): Promise<void> {
    const providerDetailsJson = JSON.stringify(
      input.ensemble.perProvider.map((p) => ({
        provider: p.provider,
        ghi: p.point?.ghi,
        timestamp: p.point?.timestamp,
        error: p.error
          ? { code: p.error.code, message: p.error.message }
          : undefined,
      })),
    );

    await this.pool.query(
      `INSERT INTO device_readings_history (
        submitted_at, device_id, session_id,
        lat_e7, lon_e7,
        epoch_start_ts, total_energy_mwh,
        ensemble_ghi, ensemble_status,
        ensemble_std_dev, ensemble_relative_div, providers_responded,
        provider_details,
        energy_zscore, anomaly_flag,
        session_key, tx_hash, submitted_to_chain
      ) VALUES (
        $1, $2, $3,
        $4, $5,
        $6, $7,
        $8, $9,
        $10, $11, $12,
        $13,
        $14, $15,
        $16, $17, $18
      )`,
      [
        input.submittedAt,
        input.deviceId.toString(),
        input.sessionId.toString(),
        input.latE7.toString(),
        input.lonE7.toString(),
        input.epochStartTs.toString(),
        input.totalEnergyMwh.toString(),
        input.ensemble.ghi,
        input.ensemble.status,
        input.ensemble.stdDev ?? null,
        input.ensemble.relativeDivergence ?? null,
        input.ensemble.providersResponded,
        providerDetailsJson,
        input.energyZscore,
        input.anomaly.flags,
        input.sessionKey ?? null,
        input.txHash ?? null,
        input.txHash !== undefined,
      ],
    );
  }
}
