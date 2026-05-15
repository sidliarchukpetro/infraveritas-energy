/**
 * SubmissionPersistence unit tests на mock pool.
 *
 * Spec: docs/specs/phase4_design.md §11.3 / §6.
 *
 * Перевіряємо що INSERT викликається з правильними parameters: bigints
 * як strings, optional fields як null, JSONB serialization, chain flag derivation.
 *
 * Run via: npm test -- persistence
 */

import { describe, it, expect, vi } from "vitest";
import {
  SubmissionPersistence,
  type PersistInput,
} from "../../../src/validation/persistence.js";
import type {
  QueryablePool,
  QueryResult,
} from "../../../src/validation/db.js";
import type { EnsembleResult } from "../../../src/validation/weather/ensemble.js";
import type { AnomalyResult } from "../../../src/validation/anomaly.js";

// ---------- Mock pool ----------

function makeMockPool(): {
  pool: QueryablePool;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn();
  query.mockResolvedValue({ rows: [], rowCount: 1 } satisfies QueryResult);
  return {
    pool: { query: query as QueryablePool["query"] },
    query,
  };
}

// ---------- Test data factories ----------

function makeEnsemble(overrides: Partial<EnsembleResult> = {}): EnsembleResult {
  return {
    ghi: 500,
    providersResponded: 3,
    stdDev: 25,
    relativeDivergence: 0.05,
    perProvider: [
      {
        provider: "open-meteo",
        point: { timestamp: 1700000000, ghi: 500, source: "open-meteo" },
      },
      {
        provider: "nasa-power",
        point: { timestamp: 1700000000, ghi: 520, source: "nasa-power" },
      },
      {
        provider: "pvgis",
        point: { timestamp: 1700000000, ghi: 480, source: "pvgis" },
      },
    ],
    status: "ok",
    ...overrides,
  };
}

function makeAnomaly(overrides: Partial<AnomalyResult> = {}): AnomalyResult {
  return {
    flags: [],
    reviewRequired: false,
    ...overrides,
  };
}

function makePersistInput(overrides: Partial<PersistInput> = {}): PersistInput {
  return {
    submittedAt: new Date("2026-05-15T12:00:00Z"),
    deviceId: 12345n,
    sessionId: 67890n,
    latE7: 484517000n, // 48.4517 × 10^7
    lonE7: 255752000n, // 25.5752 × 10^7
    epochStartTs: 1700000000n,
    totalEnergyMwh: 50000n,
    ensemble: makeEnsemble(),
    energyZscore: 0.5,
    anomaly: makeAnomaly(),
    ...overrides,
  };
}

// ---------- Happy path ----------

describe("SubmissionPersistence.persist — happy path", () => {
  it("calls INSERT once per submission", async () => {
    const { pool, query } = makeMockPool();
    const persistence = new SubmissionPersistence(pool);

    await persistence.persist(makePersistInput());

    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0]![0] as string;
    expect(sql).toContain("INSERT INTO device_readings_history");
  });

  it("does not return a value", async () => {
    const { pool } = makeMockPool();
    const persistence = new SubmissionPersistence(pool);
    const result = await persistence.persist(makePersistInput());
    expect(result).toBeUndefined();
  });
});

// ---------- BigInt encoding ----------

describe("SubmissionPersistence — bigint encoding", () => {
  it("converts bigint fields у decimal strings (Postgres BIGINT input)", async () => {
    const { pool, query } = makeMockPool();
    const persistence = new SubmissionPersistence(pool);

    await persistence.persist(
      makePersistInput({
        deviceId: 99999n,
        sessionId: 11111n,
        latE7: 484517000n,
        lonE7: 255752000n,
        epochStartTs: 1700000000n,
        totalEnergyMwh: 50000n,
      }),
    );

    const params = query.mock.calls[0]![1];

    expect(params[1]).toBe("99999"); // device_id
    expect(params[2]).toBe("11111"); // session_id
    expect(params[3]).toBe("484517000"); // lat_e7
    expect(params[4]).toBe("255752000"); // lon_e7
    expect(params[5]).toBe("1700000000"); // epoch_start_ts
    expect(params[6]).toBe("50000"); // total_energy_mwh
  });

  it("handles large bigint values (no precision loss)", async () => {
    const { pool, query } = makeMockPool();
    const persistence = new SubmissionPersistence(pool);

    // 2^63 - 1 — max int64
    const largeId = 9223372036854775807n;
    await persistence.persist(makePersistInput({ deviceId: largeId }));

    const params = query.mock.calls[0]![1];
    expect(params[1]).toBe("9223372036854775807");
  });
});

// ---------- Ensemble fields ----------

describe("SubmissionPersistence — ensemble field encoding", () => {
  it("passes ensemble fields у correct positions", async () => {
    const { pool, query } = makeMockPool();
    const persistence = new SubmissionPersistence(pool);

    await persistence.persist(
      makePersistInput({
        ensemble: makeEnsemble({
          ghi: 542.3,
          status: "ok",
          stdDev: 25.5,
          relativeDivergence: 0.047,
          providersResponded: 3,
        }),
      }),
    );

    const params = query.mock.calls[0]![1];

    expect(params[7]).toBe(542.3); // ensemble_ghi
    expect(params[8]).toBe("ok"); // ensemble_status
    expect(params[9]).toBe(25.5); // ensemble_std_dev
    expect(params[10]).toBe(0.047); // ensemble_relative_div
    expect(params[11]).toBe(3); // providers_responded
  });

  it("converts undefined optional ensemble fields to null", async () => {
    const { pool, query } = makeMockPool();
    const persistence = new SubmissionPersistence(pool);

    await persistence.persist(
      makePersistInput({
        ensemble: makeEnsemble({
          status: "degraded",
          providersResponded: 1,
          stdDev: undefined,
          relativeDivergence: undefined,
        }),
      }),
    );

    const params = query.mock.calls[0]![1];
    expect(params[9]).toBeNull(); // ensemble_std_dev
    expect(params[10]).toBeNull(); // ensemble_relative_div
  });
});

// ---------- Provider details JSONB ----------

describe("SubmissionPersistence — provider_details JSONB", () => {
  it("serializes perProvider як JSON string", async () => {
    const { pool, query } = makeMockPool();
    const persistence = new SubmissionPersistence(pool);

    await persistence.persist(makePersistInput());

    const params = query.mock.calls[0]![1];
    const detailsJson = params[12] as string;

    expect(typeof detailsJson).toBe("string");
    const parsed = JSON.parse(detailsJson);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].provider).toBe("open-meteo");
    expect(parsed[0].ghi).toBe(500);
    expect(parsed[1].provider).toBe("nasa-power");
    expect(parsed[2].provider).toBe("pvgis");
  });

  it("captures provider errors у JSON", async () => {
    const { pool, query } = makeMockPool();
    const persistence = new SubmissionPersistence(pool);

    const ensembleWithError = makeEnsemble({
      status: "degraded",
      providersResponded: 1,
      stdDev: undefined,
      relativeDivergence: undefined,
      perProvider: [
        {
          provider: "open-meteo",
          point: { timestamp: 1700000000, ghi: 500, source: "open-meteo" },
        },
        {
          provider: "nasa-power",
          // Imitate ProviderError without instantiating (test doesn't care about class instance)
          error: Object.assign(new Error("nasa-power: rate-limit: HTTP 429"), {
            provider: "nasa-power",
            code: "rate-limit" as const,
          }),
        },
      ],
    });

    await persistence.persist(makePersistInput({ ensemble: ensembleWithError }));

    const params = query.mock.calls[0]![1];
    const parsed = JSON.parse(params[12] as string);

    expect(parsed[0].ghi).toBe(500);
    expect(parsed[0].error).toBeUndefined();

    expect(parsed[1].ghi).toBeUndefined();
    expect(parsed[1].error).toBeDefined();
    expect(parsed[1].error.code).toBe("rate-limit");
    expect(parsed[1].error.message).toContain("429");
  });
});

// ---------- Anomaly + zscore ----------

describe("SubmissionPersistence — anomaly + zscore", () => {
  it("passes anomaly flags as array (Postgres text[])", async () => {
    const { pool, query } = makeMockPool();
    const persistence = new SubmissionPersistence(pool);

    await persistence.persist(
      makePersistInput({
        anomaly: makeAnomaly({
          flags: ["tamper_flag_set", "energy_zscore_high"],
          reviewRequired: true,
        }),
      }),
    );

    const params = query.mock.calls[0]![1];
    // pg client maps JS array → Postgres text[]
    expect(params[14]).toEqual(["tamper_flag_set", "energy_zscore_high"]);
  });

  it("passes empty flags array коли no anomalies", async () => {
    const { pool, query } = makeMockPool();
    const persistence = new SubmissionPersistence(pool);

    await persistence.persist(makePersistInput());

    const params = query.mock.calls[0]![1];
    expect(params[14]).toEqual([]);
  });

  it("passes energyZscore=null коли cold start", async () => {
    const { pool, query } = makeMockPool();
    const persistence = new SubmissionPersistence(pool);

    await persistence.persist(makePersistInput({ energyZscore: null }));

    const params = query.mock.calls[0]![1];
    expect(params[13]).toBeNull();
  });

  it("passes numeric energyZscore коли є data", async () => {
    const { pool, query } = makeMockPool();
    const persistence = new SubmissionPersistence(pool);

    await persistence.persist(makePersistInput({ energyZscore: 1.7 }));

    const params = query.mock.calls[0]![1];
    expect(params[13]).toBe(1.7);
  });
});

// ---------- Chain references ----------

describe("SubmissionPersistence — chain references", () => {
  it("sets submitted_to_chain=false коли txHash undefined", async () => {
    const { pool, query } = makeMockPool();
    const persistence = new SubmissionPersistence(pool);

    await persistence.persist(makePersistInput({ txHash: undefined }));

    const params = query.mock.calls[0]![1];
    expect(params[16]).toBeNull(); // tx_hash
    expect(params[17]).toBe(false); // submitted_to_chain
  });

  it("sets submitted_to_chain=true коли txHash присутній", async () => {
    const { pool, query } = makeMockPool();
    const persistence = new SubmissionPersistence(pool);

    const txHash = new Uint8Array([0xab, 0xcd, 0xef]);
    await persistence.persist(makePersistInput({ txHash }));

    const params = query.mock.calls[0]![1];
    expect(params[16]).toBe(txHash);
    expect(params[17]).toBe(true);
  });

  it("passes sessionKey коли є", async () => {
    const { pool, query } = makeMockPool();
    const persistence = new SubmissionPersistence(pool);

    const sessionKey = new Uint8Array(32).fill(0x42);
    await persistence.persist(makePersistInput({ sessionKey }));

    const params = query.mock.calls[0]![1];
    expect(params[15]).toBe(sessionKey);
  });

  it("passes sessionKey=null коли undefined", async () => {
    const { pool, query } = makeMockPool();
    const persistence = new SubmissionPersistence(pool);

    await persistence.persist(makePersistInput({ sessionKey: undefined }));

    const params = query.mock.calls[0]![1];
    expect(params[15]).toBeNull();
  });
});

// ---------- Error propagation ----------

describe("SubmissionPersistence — error handling", () => {
  it("propagates DB errors", async () => {
    const { pool, query } = makeMockPool();
    query.mockRejectedValueOnce(new Error("duplicate key violation"));

    const persistence = new SubmissionPersistence(pool);
    await expect(persistence.persist(makePersistInput())).rejects.toThrow(
      /duplicate key/,
    );
  });
});
