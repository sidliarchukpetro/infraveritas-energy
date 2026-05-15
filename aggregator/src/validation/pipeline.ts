/**
 * ValidationPipeline — єдина точка входу для cross-validation,
 * statistics, anomaly evaluation, і persistence для submission.
 *
 * Spec: docs/specs/phase4_design.md §10.
 *
 * Об'єднує всі week 1-4b компоненти у processable flow:
 *   1. Ensemble fetch — три weather sources паралельно (Promise.allSettled)
 *   2. Statistics — z-score + drift detection (DB queries паралельно)
 *   3. Anomaly — pure function що поєднує (1) + (2) + payload metadata
 *   4. Persistence — INSERT всього у device_readings_history
 *
 * Ensemble fetch і statistics queries запускаються паралельно через
 * Promise.all — вони незалежні (ensemble не торкає DB, statistics
 * не торкає network).
 *
 * Виклик не блокує chain submit — caller (worker) виконує цей метод
 * паралельно з proof gen, або після chain submit, як вирішить.
 *
 * Failure handling:
 *   - Ensemble fetch не throws (повертає 'unavailable' status у worst case)
 *   - Statistics може throw на DB errors → пропагується до caller
 *   - Persistence може throw на DB constraint violations → пропагується
 *   - Caller вирішує чи це блокує submission (default — НЕ блокує per design)
 */

import type { CanonicalPayload } from "../verify/canonical.js";
import {
  evaluateAnomaly,
  type AnomalyResult,
} from "./anomaly.js";
import type {
  EnsembleProvider,
  EnsembleResult,
} from "./weather/ensemble.js";
import type {
  StatisticsModule,
  DriftSummary,
} from "./statistics.js";
import type { SubmissionPersistence } from "./persistence.js";

// ---------- Types ----------

export interface ProcessOptions {
  /**
   * Chain reference — sessionKey (keccak256(device_id || session_id)).
   * Filled by worker після виявлення sessionKey з submission або
   * computation з payload fields.
   */
  sessionKey?: Uint8Array;

  /**
   * Chain transaction hash — filled якщо proof уже submitted on-chain.
   * undefined якщо validation запущена паралельно з proof gen.
   */
  txHash?: Uint8Array;
}

export interface ValidationOutcome {
  ensemble: EnsembleResult;
  zscore: number | null;
  drift: DriftSummary;
  anomaly: AnomalyResult;
}

// ---------- Pipeline ----------

export class ValidationPipeline {
  constructor(
    private readonly ensembleProvider: EnsembleProvider,
    private readonly statistics: StatisticsModule,
    private readonly persistence: SubmissionPersistence,
  ) {}

  /**
   * Process submission через full validation pipeline.
   *
   * Returns combined outcome — for caller to log / forward into API response.
   * Persistence уже виконана при return — sync з DB guaranteed.
   *
   * @param payload — canonical payload зі signed readings
   * @param totalEnergyMwh — computed total energy (z public inputs до ZK circuit).
   *                        Worker уже обчислює це для chain submit; passes тут
   *                        замість дублювати computation у pipeline.
   * @param options — chain references якщо вже доступні
   *
   * @throws if DB query fails (statistics OR persistence)
   *         — ensemble не кидає, повертає status='unavailable' замість того.
   */
  async process(
    payload: CanonicalPayload,
    totalEnergyMwh: bigint,
    options: ProcessOptions = {},
  ): Promise<ValidationOutcome> {
    // Decode spatial coords для weather query
    const lat = Number(payload.lat_e7) / 1e7;
    const lng = Number(payload.lon_e7) / 1e7;
    const ts = Number(payload.epoch_start_ts);

    // 1+2. Ensemble fetch і statistics queries — паралельно
    //      (ensemble — мережа, statistics — DB; незалежні)
    const [ensemble, zscore, drift] = await Promise.all([
      this.ensembleProvider.fetch(lat, lng, ts),
      this.statistics.computeEnergyZScore(
        payload.device_id,
        totalEnergyMwh,
      ),
      this.statistics.detectDrift(payload.device_id),
    ]);

    // 3. Anomaly evaluation — pure, синхронно
    const anomaly = evaluateAnomaly(
      {
        tamper_flag: payload.tamper_flag,
        total_energy_mwh: totalEnergyMwh,
      },
      ensemble,
      zscore,
      drift,
    );

    // 4. Persist combined result
    await this.persistence.persist({
      submittedAt: new Date(),
      deviceId: payload.device_id,
      sessionId: payload.session_id,
      latE7: payload.lat_e7,
      lonE7: payload.lon_e7,
      epochStartTs: payload.epoch_start_ts,
      totalEnergyMwh: totalEnergyMwh,
      ensemble,
      energyZscore: zscore,
      anomaly,
      sessionKey: options.sessionKey,
      txHash: options.txHash,
    });

    return { ensemble, zscore, drift, anomaly };
  }
}
