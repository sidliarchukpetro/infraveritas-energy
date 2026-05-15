/**
 * ValidationPipeline unit tests на mocked components.
 *
 * Spec: docs/specs/phase4_design.md §10.
 *
 * Перевіряємо orchestration logic — що pipeline викликає всі 4 components
 * у правильному порядку з правильними args, і повертає aggregated outcome.
 *
 * Real DB/network не задіяні — кожен component mocked через vi.fn().
 *
 * Run via: npm test -- pipeline
 */

import { describe, it, expect, vi } from "vitest";
import {
  ValidationPipeline,
} from "../../../src/validation/pipeline.js";
import type { CanonicalPayload, Reading } from "../../../src/verify/canonical.js";
import type {
  EnsembleProvider,
  EnsembleResult,
} from "../../../src/validation/weather/ensemble.js";
import type { StatisticsModule, DriftSummary } from "../../../src/validation/statistics.js";
import type { SubmissionPersistence } from "../../../src/validation/persistence.js";

// ---------- Factory: minimal valid CanonicalPayload ----------

function makeReadings(count: number = 100): Reading[] {
  const readings: Reading[] = [];
  for (let i = 0; i < count; i++) {
    readings.push({
      voltage_mv: 12000n,
      current_ma: 5000n,
      timestamp_ms: BigInt(1700000000000 + i * 30000),
    });
  }
  return readings;
}

function makePayload(overrides: Partial<CanonicalPayload> = {}): CanonicalPayload {
  return {
    device_id: 12345n,
    session_id: 67890n,
    epoch_start_ts: 1700000000n,
    lat_e7: 484517000n,    // 48.4517°
    lon_e7: 255752000n,    // 25.5752°
    light_level: 50000n,
    tamper_flag: 0n,
    readings: makeReadings(),
    ...overrides,
  };
}

/**
 * Test default для totalEnergyMwh — passed як explicit param у process().
 * В production цей value обчислюється worker-ом з readings і передається.
 */
const DEFAULT_TOTAL_ENERGY_MWH = 50000n;

// ---------- Mock factories ----------

function makeEnsembleResult(overrides: Partial<EnsembleResult> = {}): EnsembleResult {
  return {
    ghi: 500,
    providersResponded: 3,
    stdDev: 25,
    relativeDivergence: 0.05,
    perProvider: [],
    status: "ok",
    ...overrides,
  };
}

function makeDrift(overrides: Partial<DriftSummary> = {}): DriftSummary {
  return { drift: false, magnitude: 0, ...overrides };
}

interface Mocks {
  ensemble: EnsembleProvider;
  statistics: StatisticsModule;
  persistence: SubmissionPersistence;
  ensembleFetch: ReturnType<typeof vi.fn>;
  zscoreFn: ReturnType<typeof vi.fn>;
  driftFn: ReturnType<typeof vi.fn>;
  persistFn: ReturnType<typeof vi.fn>;
}

function makeMocks(opts: {
  ensembleResult?: EnsembleResult;
  zscore?: number | null;
  drift?: DriftSummary;
} = {}): Mocks {
  const ensembleFetch = vi.fn().mockResolvedValue(
    opts.ensembleResult ?? makeEnsembleResult(),
  );
  const zscoreFn = vi.fn().mockResolvedValue(opts.zscore ?? 0.5);
  const driftFn = vi.fn().mockResolvedValue(opts.drift ?? makeDrift());
  const persistFn = vi.fn().mockResolvedValue(undefined);

  const ensemble = { fetch: ensembleFetch } as unknown as EnsembleProvider;
  const statistics = {
    computeEnergyZScore: zscoreFn,
    detectDrift: driftFn,
  } as unknown as StatisticsModule;
  const persistence = { persist: persistFn } as unknown as SubmissionPersistence;

  return { ensemble, statistics, persistence, ensembleFetch, zscoreFn, driftFn, persistFn };
}

// ---------- Happy path ----------

describe("ValidationPipeline.process — orchestration", () => {
  it("calls усі 4 components і повертає aggregated outcome", async () => {
    const mocks = makeMocks();
    const pipeline = new ValidationPipeline(
      mocks.ensemble,
      mocks.statistics,
      mocks.persistence,
    );

    const outcome = await pipeline.process(makePayload(), DEFAULT_TOTAL_ENERGY_MWH);

    expect(mocks.ensembleFetch).toHaveBeenCalledTimes(1);
    expect(mocks.zscoreFn).toHaveBeenCalledTimes(1);
    expect(mocks.driftFn).toHaveBeenCalledTimes(1);
    expect(mocks.persistFn).toHaveBeenCalledTimes(1);

    expect(outcome.ensemble.status).toBe("ok");
    expect(outcome.zscore).toBe(0.5);
    expect(outcome.drift.drift).toBe(false);
    expect(outcome.anomaly.flags).toEqual([]);
  });

  it("decodes lat/lng correctly з e7 scaling", async () => {
    const mocks = makeMocks();
    const pipeline = new ValidationPipeline(
      mocks.ensemble,
      mocks.statistics,
      mocks.persistence,
    );

    await pipeline.process(
      makePayload({ lat_e7: 484517000n, lon_e7: 255752000n }),
      DEFAULT_TOTAL_ENERGY_MWH,
    );

    // EnsembleProvider.fetch(lat, lng, ts)
    const callArgs = mocks.ensembleFetch.mock.calls[0];
    expect(callArgs).toBeDefined();
    const [lat, lng, ts] = callArgs!;
    expect(lat).toBeCloseTo(48.4517, 4);
    expect(lng).toBeCloseTo(25.5752, 4);
    expect(ts).toBe(1700000000);
  });

  it("passes device_id і totalEnergyMwh до StatisticsModule", async () => {
    const mocks = makeMocks();
    const pipeline = new ValidationPipeline(
      mocks.ensemble,
      mocks.statistics,
      mocks.persistence,
    );

    await pipeline.process(
      makePayload({ device_id: 99999n }),
      12345n,
    );

    const zscoreCall = mocks.zscoreFn.mock.calls[0];
    expect(zscoreCall).toBeDefined();
    expect(zscoreCall![0]).toBe(99999n);
    expect(zscoreCall![1]).toBe(12345n);

    const driftCall = mocks.driftFn.mock.calls[0];
    expect(driftCall).toBeDefined();
    expect(driftCall![0]).toBe(99999n);
  });

  it("persists з усіма правильними fields", async () => {
    const mocks = makeMocks();
    const pipeline = new ValidationPipeline(
      mocks.ensemble,
      mocks.statistics,
      mocks.persistence,
    );

    const payload = makePayload({
      device_id: 11111n,
      session_id: 22222n,
      lat_e7: 484517000n,
      lon_e7: 255752000n,
      epoch_start_ts: 1700000000n,
    });

    await pipeline.process(payload, 88888n);

    const persistCall = mocks.persistFn.mock.calls[0];
    expect(persistCall).toBeDefined();
    const input = persistCall![0];

    expect(input.deviceId).toBe(11111n);
    expect(input.sessionId).toBe(22222n);
    expect(input.latE7).toBe(484517000n);
    expect(input.lonE7).toBe(255752000n);
    expect(input.epochStartTs).toBe(1700000000n);
    expect(input.totalEnergyMwh).toBe(88888n);
    expect(input.energyZscore).toBe(0.5);
    expect(input.submittedAt).toBeInstanceOf(Date);
    expect(input.ensemble.status).toBe("ok");
    expect(input.anomaly.flags).toEqual([]);
  });
});

// ---------- Chain refs передача ----------

describe("ValidationPipeline.process — chain references", () => {
  it("forwards sessionKey і txHash з options до persistence", async () => {
    const mocks = makeMocks();
    const pipeline = new ValidationPipeline(
      mocks.ensemble,
      mocks.statistics,
      mocks.persistence,
    );

    const sessionKey = new Uint8Array(32).fill(0x42);
    const txHash = new Uint8Array(32).fill(0xab);

    await pipeline.process(makePayload(), DEFAULT_TOTAL_ENERGY_MWH, {
      sessionKey,
      txHash,
    });

    const persistInput = mocks.persistFn.mock.calls[0]![0];
    expect(persistInput.sessionKey).toBe(sessionKey);
    expect(persistInput.txHash).toBe(txHash);
  });

  it("passes undefined chain refs коли options not provided", async () => {
    const mocks = makeMocks();
    const pipeline = new ValidationPipeline(
      mocks.ensemble,
      mocks.statistics,
      mocks.persistence,
    );

    await pipeline.process(makePayload(), DEFAULT_TOTAL_ENERGY_MWH);

    const persistInput = mocks.persistFn.mock.calls[0]![0];
    expect(persistInput.sessionKey).toBeUndefined();
    expect(persistInput.txHash).toBeUndefined();
  });

  it("supports partial options (sessionKey без txHash)", async () => {
    const mocks = makeMocks();
    const pipeline = new ValidationPipeline(
      mocks.ensemble,
      mocks.statistics,
      mocks.persistence,
    );

    const sessionKey = new Uint8Array(32).fill(0x33);
    await pipeline.process(makePayload(), DEFAULT_TOTAL_ENERGY_MWH, {
      sessionKey,
    });

    const persistInput = mocks.persistFn.mock.calls[0]![0];
    expect(persistInput.sessionKey).toBe(sessionKey);
    expect(persistInput.txHash).toBeUndefined();
  });
});

// ---------- Anomaly evaluation triggers ----------

describe("ValidationPipeline.process — anomaly flags propagation", () => {
  it("flags tamper_flag_set коли payload tamper_flag !== 0", async () => {
    const mocks = makeMocks();
    const pipeline = new ValidationPipeline(
      mocks.ensemble,
      mocks.statistics,
      mocks.persistence,
    );

    const outcome = await pipeline.process(
      makePayload({ tamper_flag: 1n }),
      DEFAULT_TOTAL_ENERGY_MWH,
    );

    expect(outcome.anomaly.flags).toContain("tamper_flag_set");
    expect(outcome.anomaly.reviewRequired).toBe(true);
  });

  it("flags нічну генерацію (ghi=0 + energy claim)", async () => {
    const mocks = makeMocks({
      ensembleResult: makeEnsembleResult({ ghi: 0, status: "ok" }),
    });
    const pipeline = new ValidationPipeline(
      mocks.ensemble,
      mocks.statistics,
      mocks.persistence,
    );

    // 5000n > NIGHT_ENERGY_THRESHOLD (100n) у anomaly evaluator
    const outcome = await pipeline.process(makePayload(), 5000n);

    expect(outcome.anomaly.flags).toContain("energy_inconsistent_with_weather");
  });

  it("flags energy_zscore_high коли statistics returns outlier", async () => {
    const mocks = makeMocks({ zscore: 4.5 });
    const pipeline = new ValidationPipeline(
      mocks.ensemble,
      mocks.statistics,
      mocks.persistence,
    );

    const outcome = await pipeline.process(makePayload(), DEFAULT_TOTAL_ENERGY_MWH);

    expect(outcome.anomaly.flags).toContain("energy_zscore_high");
  });

  it("flags drift_detected коли statistics returns drift", async () => {
    const mocks = makeMocks({
      drift: { drift: true, magnitude: 3.0 },
    });
    const pipeline = new ValidationPipeline(
      mocks.ensemble,
      mocks.statistics,
      mocks.persistence,
    );

    const outcome = await pipeline.process(makePayload(), DEFAULT_TOTAL_ENERGY_MWH);

    expect(outcome.anomaly.flags).toContain("drift_detected");
  });

  it("flags weather_unavailable коли ensemble.status === 'unavailable'", async () => {
    const mocks = makeMocks({
      ensembleResult: makeEnsembleResult({
        status: "unavailable",
        providersResponded: 0,
        ghi: 0,
      }),
    });
    const pipeline = new ValidationPipeline(
      mocks.ensemble,
      mocks.statistics,
      mocks.persistence,
    );

    const outcome = await pipeline.process(makePayload(), DEFAULT_TOTAL_ENERGY_MWH);

    expect(outcome.anomaly.flags).toContain("weather_unavailable");
  });
});

// ---------- Error propagation ----------

describe("ValidationPipeline.process — error propagation", () => {
  it("propagates statistics error (DB connection)", async () => {
    const mocks = makeMocks();
    mocks.zscoreFn.mockRejectedValueOnce(new Error("connection refused"));

    const pipeline = new ValidationPipeline(
      mocks.ensemble,
      mocks.statistics,
      mocks.persistence,
    );

    await expect(
      pipeline.process(makePayload(), DEFAULT_TOTAL_ENERGY_MWH),
    ).rejects.toThrow(/connection refused/);
    expect(mocks.persistFn).not.toHaveBeenCalled();
  });

  it("propagates persistence error (INSERT failure)", async () => {
    const mocks = makeMocks();
    mocks.persistFn.mockRejectedValueOnce(new Error("constraint violation"));

    const pipeline = new ValidationPipeline(
      mocks.ensemble,
      mocks.statistics,
      mocks.persistence,
    );

    await expect(
      pipeline.process(makePayload(), DEFAULT_TOTAL_ENERGY_MWH),
    ).rejects.toThrow(/constraint violation/);
  });
});

// ---------- Parallel execution ----------

describe("ValidationPipeline.process — parallel execution", () => {
  it("викликає ensemble + statistics queries паралельно", async () => {
    // Кожен mock з 100ms delay. Якщо sequential — total ~300ms+.
    // Якщо parallel — ~100ms.
    const delayMs = 100;

    const ensembleFetch = vi.fn().mockImplementation(
      async () => {
        await new Promise(r => setTimeout(r, delayMs));
        return makeEnsembleResult();
      },
    );
    const zscoreFn = vi.fn().mockImplementation(
      async () => {
        await new Promise(r => setTimeout(r, delayMs));
        return 0.5;
      },
    );
    const driftFn = vi.fn().mockImplementation(
      async () => {
        await new Promise(r => setTimeout(r, delayMs));
        return makeDrift();
      },
    );

    const ensemble = { fetch: ensembleFetch } as unknown as EnsembleProvider;
    const statistics = {
      computeEnergyZScore: zscoreFn,
      detectDrift: driftFn,
    } as unknown as StatisticsModule;
    const persistence = {
      persist: vi.fn().mockResolvedValue(undefined),
    } as unknown as SubmissionPersistence;

    const pipeline = new ValidationPipeline(ensemble, statistics, persistence);

    const start = Date.now();
    await pipeline.process(makePayload(), DEFAULT_TOTAL_ENERGY_MWH);
    const elapsed = Date.now() - start;

    // Parallel — close to delayMs, not 3*delayMs.
    // Дозволяємо ~250ms upper bound для slow CI.
    expect(elapsed).toBeLessThan(delayMs * 2.5);
  });
});
