/**
 * StatisticsModule unit tests на mock pool.
 *
 * Spec: docs/specs/phase4_design.md §11.3.
 *
 * No real Postgres needed — використовуємо vi.fn() для simulating
 * query responses. Production wiring (real pg.Pool) до main.ts;
 * tests тут перевіряють тільки business logic.
 *
 * Run via: npm test -- statistics
 */

import { describe, it, expect, vi } from "vitest";
import { StatisticsModule } from "../../../src/validation/statistics.js";
import type {
  QueryablePool,
  QueryResult,
  QueryResultRow,
} from "../../../src/validation/db.js";

// ---------- Mock pool helper ----------

interface MockPool {
  pool: QueryablePool;
  query: ReturnType<typeof vi.fn>;
}

function makeMockPool<R extends QueryResultRow>(
  defaultRows: R[] = [],
): MockPool {
  const query = vi.fn();
  query.mockResolvedValue({
    rows: defaultRows,
    rowCount: defaultRows.length,
  } satisfies QueryResult<R>);

  const pool: QueryablePool = {
    query: query as QueryablePool["query"],
  };

  return { pool, query };
}

const DEVICE_ID = 12345n;

// ---------- computeEnergyZScore ----------

describe("StatisticsModule.computeEnergyZScore", () => {
  it("returns normalized z-score для valid history", async () => {
    const { pool } = makeMockPool([{ mean: 100, std: 10, n: "20" }]);
    const stats = new StatisticsModule(pool);

    // current=130, mean=100, std=10 → z = (130-100)/10 = 3
    const z = await stats.computeEnergyZScore(DEVICE_ID, 130n);
    expect(z).toBe(3);
  });

  it("computes negative z-score для below-mean values", async () => {
    const { pool } = makeMockPool([{ mean: 1000, std: 100, n: "50" }]);
    const stats = new StatisticsModule(pool);

    // current=700, mean=1000, std=100 → z = -3
    const z = await stats.computeEnergyZScore(DEVICE_ID, 700n);
    expect(z).toBe(-3);
  });

  it("computes z-score=0 коли value matches mean exactly", async () => {
    const { pool } = makeMockPool([{ mean: 500, std: 100, n: "30" }]);
    const stats = new StatisticsModule(pool);

    const z = await stats.computeEnergyZScore(DEVICE_ID, 500n);
    expect(z).toBe(0);
  });

  it("returns null коли n < 10 (cold start)", async () => {
    const { pool } = makeMockPool([{ mean: 100, std: 10, n: "5" }]);
    const stats = new StatisticsModule(pool);

    const z = await stats.computeEnergyZScore(DEVICE_ID, 130n);
    expect(z).toBeNull();
  });

  it("returns null коли n >= 10 але std = 0 (zero variance)", async () => {
    const { pool } = makeMockPool([{ mean: 100, std: 0, n: "20" }]);
    const stats = new StatisticsModule(pool);

    const z = await stats.computeEnergyZScore(DEVICE_ID, 130n);
    expect(z).toBeNull();
  });

  it("returns null коли mean is null (empty filtered set)", async () => {
    const { pool } = makeMockPool([{ mean: null, std: null, n: "0" }]);
    const stats = new StatisticsModule(pool);

    const z = await stats.computeEnergyZScore(DEVICE_ID, 130n);
    expect(z).toBeNull();
  });

  it("returns null коли std is null", async () => {
    const { pool } = makeMockPool([{ mean: 100, std: null, n: "20" }]);
    const stats = new StatisticsModule(pool);

    const z = await stats.computeEnergyZScore(DEVICE_ID, 130n);
    expect(z).toBeNull();
  });

  it("returns null коли rows array empty", async () => {
    const { pool } = makeMockPool([]);
    const stats = new StatisticsModule(pool);

    const z = await stats.computeEnergyZScore(DEVICE_ID, 130n);
    expect(z).toBeNull();
  });

  it("passes correct SQL params (deviceId as string)", async () => {
    const { pool, query } = makeMockPool([{ mean: 100, std: 10, n: "20" }]);
    const stats = new StatisticsModule(pool);

    await stats.computeEnergyZScore(DEVICE_ID, 130n);

    expect(query).toHaveBeenCalledTimes(1);
    const call = query.mock.calls[0];
    expect(call).toBeDefined();
    const [sql, params] = call!;

    expect(sql).toContain("FROM device_readings_history");
    expect(sql).toContain("device_id = $1");
    expect(sql).toContain("submitted_at >= to_timestamp($2)");
    expect(sql).toContain("ensemble_status IN ('ok', 'degraded')");
    expect(params[0]).toBe("12345");
  });

  it("passes window timestamp у correct range (default 7 days)", async () => {
    const { pool, query } = makeMockPool([{ mean: 100, std: 10, n: "20" }]);
    const stats = new StatisticsModule(pool);

    const before = Math.floor(Date.now() / 1000);
    await stats.computeEnergyZScore(DEVICE_ID, 130n);
    const after = Math.floor(Date.now() / 1000);

    const params = query.mock.calls[0]![1];
    const windowStart = params[1] as number;
    const expectedWindow = 7 * 24 * 3600;

    expect(windowStart).toBeGreaterThanOrEqual(before - expectedWindow);
    expect(windowStart).toBeLessThanOrEqual(after - expectedWindow);
  });

  it("respects custom window seconds", async () => {
    const { pool, query } = makeMockPool([{ mean: 100, std: 10, n: "20" }]);
    const stats = new StatisticsModule(pool);

    const customWindow = 24 * 3600; // 1 day
    const before = Math.floor(Date.now() / 1000);
    await stats.computeEnergyZScore(DEVICE_ID, 130n, customWindow);
    const after = Math.floor(Date.now() / 1000);

    const params = query.mock.calls[0]![1];
    const windowStart = params[1] as number;
    expect(windowStart).toBeGreaterThanOrEqual(before - customWindow);
    expect(windowStart).toBeLessThanOrEqual(after - customWindow);
  });

  it("propagates DB errors (не swallow)", async () => {
    const { pool, query } = makeMockPool([]);
    query.mockRejectedValueOnce(new Error("connection refused"));
    const stats = new StatisticsModule(pool);

    await expect(stats.computeEnergyZScore(DEVICE_ID, 130n)).rejects.toThrow(
      /connection refused/,
    );
  });
});

// ---------- detectDrift ----------

describe("StatisticsModule.detectDrift", () => {
  it("returns drift=true коли magnitude > 2.0 std", async () => {
    const { pool } = makeMockPool([
      { recent_mean: 500, baseline_mean: 300, baseline_std: 50 },
    ]);
    const stats = new StatisticsModule(pool);

    // magnitude = |500-300|/50 = 4 > 2 → drift
    const result = await stats.detectDrift(DEVICE_ID);
    expect(result.drift).toBe(true);
    expect(result.magnitude).toBe(4);
  });

  it("returns drift=false коли magnitude <= 2.0", async () => {
    const { pool } = makeMockPool([
      { recent_mean: 320, baseline_mean: 300, baseline_std: 50 },
    ]);
    const stats = new StatisticsModule(pool);

    // magnitude = |320-300|/50 = 0.4 < 2 → no drift
    const result = await stats.detectDrift(DEVICE_ID);
    expect(result.drift).toBe(false);
    expect(result.magnitude).toBe(0.4);
  });

  it("returns drift=false коли magnitude exactly 2.0 (strict >)", async () => {
    const { pool } = makeMockPool([
      { recent_mean: 400, baseline_mean: 300, baseline_std: 50 },
    ]);
    const stats = new StatisticsModule(pool);

    // magnitude = |400-300|/50 = 2.0 — NOT > 2.0
    const result = await stats.detectDrift(DEVICE_ID);
    expect(result.drift).toBe(false);
    expect(result.magnitude).toBe(2);
  });

  it("detects downward drift (negative shift, uses abs)", async () => {
    const { pool } = makeMockPool([
      { recent_mean: 100, baseline_mean: 500, baseline_std: 50 },
    ]);
    const stats = new StatisticsModule(pool);

    // magnitude = |100-500|/50 = 8 → drift detected
    const result = await stats.detectDrift(DEVICE_ID);
    expect(result.drift).toBe(true);
    expect(result.magnitude).toBe(8);
  });

  it("returns no drift коли baseline_std == 0", async () => {
    const { pool } = makeMockPool([
      { recent_mean: 500, baseline_mean: 300, baseline_std: 0 },
    ]);
    const stats = new StatisticsModule(pool);

    const result = await stats.detectDrift(DEVICE_ID);
    expect(result).toEqual({ drift: false, magnitude: 0 });
  });

  it("returns no drift коли recent_mean is null", async () => {
    const { pool } = makeMockPool([
      { recent_mean: null, baseline_mean: 300, baseline_std: 50 },
    ]);
    const stats = new StatisticsModule(pool);

    const result = await stats.detectDrift(DEVICE_ID);
    expect(result).toEqual({ drift: false, magnitude: 0 });
  });

  it("returns no drift коли baseline_mean is null", async () => {
    const { pool } = makeMockPool([
      { recent_mean: 500, baseline_mean: null, baseline_std: 50 },
    ]);
    const stats = new StatisticsModule(pool);

    const result = await stats.detectDrift(DEVICE_ID);
    expect(result).toEqual({ drift: false, magnitude: 0 });
  });

  it("returns no drift коли baseline_std is null", async () => {
    const { pool } = makeMockPool([
      { recent_mean: 500, baseline_mean: 300, baseline_std: null },
    ]);
    const stats = new StatisticsModule(pool);

    const result = await stats.detectDrift(DEVICE_ID);
    expect(result).toEqual({ drift: false, magnitude: 0 });
  });

  it("returns no drift коли rows empty", async () => {
    const { pool } = makeMockPool([]);
    const stats = new StatisticsModule(pool);

    const result = await stats.detectDrift(DEVICE_ID);
    expect(result).toEqual({ drift: false, magnitude: 0 });
  });

  it("passes deviceId у SQL params", async () => {
    const { pool, query } = makeMockPool([]);
    const stats = new StatisticsModule(pool);

    await stats.detectDrift(DEVICE_ID);

    expect(query).toHaveBeenCalledTimes(1);
    const params = query.mock.calls[0]![1];
    expect(params[0]).toBe("12345");
  });

  it("uses FILTER clauses у SQL (window comparison)", async () => {
    const { pool, query } = makeMockPool([]);
    const stats = new StatisticsModule(pool);

    await stats.detectDrift(DEVICE_ID);

    const sql = query.mock.calls[0]![0] as string;
    expect(sql).toContain("FILTER");
    expect(sql).toContain("INTERVAL '24 hours'");
    expect(sql).toContain("INTERVAL '7 days'");
  });
});
