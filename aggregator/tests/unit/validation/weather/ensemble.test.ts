/**
 * EnsembleProvider unit tests.
 *
 * Spec: docs/specs/phase4_design.md §11.2.
 *
 * Tests use fake IrradianceProvider implementations — pure logic test,
 * no HTTP. Run via: npm test -- ensemble
 *
 * Covers:
 *   - Status classification: ok / degraded / divergent / unavailable
 *   - Median calculation (odd/even count, sorted vs unsorted input)
 *   - Std deviation і relative divergence
 *   - Night case (median=0) з absolute threshold
 *   - Custom thresholds через options
 *   - Per-provider error preservation
 *   - Constructor validation
 */

import { describe, it, expect } from "vitest";
import { EnsembleProvider } from "../../../../src/validation/weather/ensemble.js";
import {
  type IrradianceProvider,
  type IrradiancePoint,
  ProviderError,
} from "../../../../src/validation/weather/provider.js";

// ---------- Fake providers ----------

class FakeOkProvider implements IrradianceProvider {
  constructor(
    public readonly name: string,
    private readonly ghi: number,
    private readonly source: IrradiancePoint["source"] = "open-meteo",
  ) {}

  async fetch(_lat: number, _lng: number, ts: number): Promise<IrradiancePoint> {
    return { timestamp: ts, ghi: this.ghi, source: this.source };
  }

  isHealthy(): boolean {
    return true;
  }
}

class FakeFailingProvider implements IrradianceProvider {
  constructor(
    public readonly name: string,
    private readonly errorCode: "network" | "rate-limit" | "malformed" | "not-found" = "network",
  ) {}

  async fetch(): Promise<IrradiancePoint> {
    throw new ProviderError(this.name, this.errorCode, "simulated failure");
  }

  isHealthy(): boolean {
    return false;
  }
}

const LAT = 48.4517;
const LNG = 25.5752;
const TS = 1700000000;

// ---------- Status: 'ok' ----------

describe("EnsembleProvider — status: 'ok'", () => {
  it("returns 'ok' коли 3 providers співпадають у межах порогу", async () => {
    // [495, 500, 510] — median=500, stdDev~6.24, divergence~1.25% << 30%
    const ensemble = new EnsembleProvider([
      new FakeOkProvider("a", 500, "open-meteo"),
      new FakeOkProvider("b", 510, "nasa-power"),
      new FakeOkProvider("c", 495, "pvgis"),
    ]);

    const result = await ensemble.fetch(LAT, LNG, TS);

    expect(result.status).toBe("ok");
    expect(result.providersResponded).toBe(3);
    expect(result.ghi).toBe(500);
    expect(result.stdDev).toBeGreaterThan(0);
    expect(result.relativeDivergence).toBeLessThan(0.30);
  });

  it("returns 'ok' коли 2 providers співпадають, третій failed", async () => {
    const ensemble = new EnsembleProvider([
      new FakeOkProvider("a", 500),
      new FakeOkProvider("b", 510),
      new FakeFailingProvider("c"),
    ]);

    const result = await ensemble.fetch(LAT, LNG, TS);

    expect(result.status).toBe("ok");
    expect(result.providersResponded).toBe(2);
    expect(result.ghi).toBe(505); // (500 + 510) / 2 — even count
  });

  it("preserves per-provider details включаючи failed", async () => {
    const ensemble = new EnsembleProvider([
      new FakeOkProvider("a", 500),
      new FakeFailingProvider("b", "rate-limit"),
      new FakeOkProvider("c", 510),
    ]);

    const result = await ensemble.fetch(LAT, LNG, TS);

    expect(result.perProvider).toHaveLength(3);

    const failedResult = result.perProvider.find((p) => p.provider === "b");
    expect(failedResult?.error).toBeInstanceOf(ProviderError);
    expect(failedResult?.error?.code).toBe("rate-limit");
    expect(failedResult?.point).toBeUndefined();

    const okResult = result.perProvider.find((p) => p.provider === "a");
    expect(okResult?.point?.ghi).toBe(500);
    expect(okResult?.error).toBeUndefined();
  });
});

// ---------- Status: 'degraded' ----------

describe("EnsembleProvider — status: 'degraded'", () => {
  it("returns 'degraded' коли тільки 1 provider responded", async () => {
    const ensemble = new EnsembleProvider([
      new FakeOkProvider("a", 400),
      new FakeFailingProvider("b"),
      new FakeFailingProvider("c"),
    ]);

    const result = await ensemble.fetch(LAT, LNG, TS);

    expect(result.status).toBe("degraded");
    expect(result.providersResponded).toBe(1);
    expect(result.ghi).toBe(400);
    expect(result.stdDev).toBeUndefined();
    expect(result.relativeDivergence).toBeUndefined();
  });
});

// ---------- Status: 'divergent' ----------

describe("EnsembleProvider — status: 'divergent'", () => {
  it("returns 'divergent' коли providers розходяться вище 30%", async () => {
    // [100, 500, 900] — median=500, stdDev~327, divergence~65% > 30%
    const ensemble = new EnsembleProvider([
      new FakeOkProvider("a", 100),
      new FakeOkProvider("b", 500),
      new FakeOkProvider("c", 900),
    ]);

    const result = await ensemble.fetch(LAT, LNG, TS);

    expect(result.status).toBe("divergent");
    expect(result.providersResponded).toBe(3);
    expect(result.ghi).toBe(500);
    expect(result.relativeDivergence).toBeGreaterThan(0.30);
  });

  it("respects custom divergenceThreshold (строгіший)", async () => {
    // [480, 500, 520] — divergence ~3.3%, > 1% threshold → divergent
    const ensemble = new EnsembleProvider(
      [
        new FakeOkProvider("a", 480),
        new FakeOkProvider("b", 500),
        new FakeOkProvider("c", 520),
      ],
      { divergenceThreshold: 0.01 },
    );

    const result = await ensemble.fetch(LAT, LNG, TS);
    expect(result.status).toBe("divergent");
  });

  it("treats divergence == threshold як 'divergent' (>=)", async () => {
    // Підбираємо threshold що точно <= computed divergence
    // [100, 500, 900] → divergence ~65%. Threshold 0.65 → divergent
    const ensemble = new EnsembleProvider(
      [
        new FakeOkProvider("a", 100),
        new FakeOkProvider("b", 500),
        new FakeOkProvider("c", 900),
      ],
      { divergenceThreshold: 0.65 },
    );

    const result = await ensemble.fetch(LAT, LNG, TS);
    expect(result.status).toBe("divergent");
  });
});

// ---------- Status: 'unavailable' ----------

describe("EnsembleProvider — status: 'unavailable'", () => {
  it("returns 'unavailable' коли ВСІ providers failed", async () => {
    const ensemble = new EnsembleProvider([
      new FakeFailingProvider("a", "network"),
      new FakeFailingProvider("b", "rate-limit"),
      new FakeFailingProvider("c", "malformed"),
    ]);

    const result = await ensemble.fetch(LAT, LNG, TS);

    expect(result.status).toBe("unavailable");
    expect(result.providersResponded).toBe(0);
    expect(result.ghi).toBe(0);
    expect(result.stdDev).toBeUndefined();
    expect(result.relativeDivergence).toBeUndefined();
    expect(result.perProvider).toHaveLength(3);
    expect(result.perProvider.every((p) => p.error !== undefined)).toBe(true);
  });
});

// ---------- Night case (median=0) ----------

describe("EnsembleProvider — night case (median=0)", () => {
  it("returns 'ok' коли всі providers report 0 GHI (consistent night)", async () => {
    const ensemble = new EnsembleProvider([
      new FakeOkProvider("a", 0),
      new FakeOkProvider("b", 0),
      new FakeOkProvider("c", 0),
    ]);

    const result = await ensemble.fetch(LAT, LNG, TS);

    expect(result.status).toBe("ok");
    expect(result.ghi).toBe(0);
    expect(result.stdDev).toBe(0);
    expect(result.relativeDivergence).toBeUndefined();
  });

  it("returns 'ok' коли night values within absolute threshold", async () => {
    // [0, 0, 20] → median=0, stdDev~9.4 — < 50 nightStdThreshold
    const ensemble = new EnsembleProvider([
      new FakeOkProvider("a", 0),
      new FakeOkProvider("b", 0),
      new FakeOkProvider("c", 20),
    ]);

    const result = await ensemble.fetch(LAT, LNG, TS);

    expect(result.ghi).toBe(0); // median з [0, 0, 20]
    expect(result.status).toBe("ok");
    expect(result.relativeDivergence).toBeUndefined();
  });

  it("returns 'divergent' коли night case has std > nightStdThreshold", async () => {
    // [0, 0, 300] → median=0, stdDev~141 > 50 absolute threshold
    const ensemble = new EnsembleProvider([
      new FakeOkProvider("a", 0),
      new FakeOkProvider("b", 0),
      new FakeOkProvider("c", 300),
    ]);

    const result = await ensemble.fetch(LAT, LNG, TS);

    expect(result.ghi).toBe(0);
    expect(result.status).toBe("divergent");
    expect(result.stdDev).toBeGreaterThan(50);
  });

  it("respects custom nightStdThreshold", async () => {
    // [0, 0, 30] → stdDev~14. Custom threshold 10 → divergent (14 > 10)
    const ensemble = new EnsembleProvider(
      [
        new FakeOkProvider("a", 0),
        new FakeOkProvider("b", 0),
        new FakeOkProvider("c", 30),
      ],
      { nightStdThreshold: 10 },
    );

    const result = await ensemble.fetch(LAT, LNG, TS);
    expect(result.ghi).toBe(0);
    expect(result.status).toBe("divergent");
  });
});

// ---------- Median calculation ----------

describe("EnsembleProvider — median calculation", () => {
  it("computes correct median для odd count (3)", async () => {
    const ensemble = new EnsembleProvider([
      new FakeOkProvider("a", 100),
      new FakeOkProvider("b", 200),
      new FakeOkProvider("c", 300),
    ]);

    const result = await ensemble.fetch(LAT, LNG, TS);
    expect(result.ghi).toBe(200);
  });

  it("computes correct median для even count (2)", async () => {
    const ensemble = new EnsembleProvider([
      new FakeOkProvider("a", 400),
      new FakeOkProvider("b", 600),
      new FakeFailingProvider("c"),
    ]);

    const result = await ensemble.fetch(LAT, LNG, TS);
    expect(result.ghi).toBe(500); // (400 + 600) / 2
  });

  it("sorts values перед median (input order не має значення)", async () => {
    const ensemble = new EnsembleProvider([
      new FakeOkProvider("a", 900),
      new FakeOkProvider("b", 100),
      new FakeOkProvider("c", 500),
    ]);

    const result = await ensemble.fetch(LAT, LNG, TS);
    expect(result.ghi).toBe(500);
  });
});

// ---------- Constructor ----------

describe("EnsembleProvider — constructor", () => {
  it("throws коли empty providers array", () => {
    expect(() => new EnsembleProvider([])).toThrow(/at least one/);
  });

  it("works з single provider — завжди 'degraded' якщо response OK", async () => {
    const ensemble = new EnsembleProvider([new FakeOkProvider("solo", 444)]);
    const result = await ensemble.fetch(LAT, LNG, TS);
    expect(result.status).toBe("degraded");
    expect(result.providersResponded).toBe(1);
    expect(result.ghi).toBe(444);
  });

  it("works з single provider — 'unavailable' якщо failed", async () => {
    const ensemble = new EnsembleProvider([new FakeFailingProvider("solo")]);
    const result = await ensemble.fetch(LAT, LNG, TS);
    expect(result.status).toBe("unavailable");
  });
});

// ---------- Parallel execution ----------

describe("EnsembleProvider — parallel execution", () => {
  it("викликає всі providers concurrently (не sequentially)", async () => {
    // Якщо calls sequential — total time ≥ sum of delays.
    // Якщо parallel — total time ~max(delays).
    class DelayedProvider implements IrradianceProvider {
      constructor(public readonly name: string, private readonly delay: number) {}
      async fetch(_lat: number, _lng: number, ts: number): Promise<IrradiancePoint> {
        await new Promise((r) => setTimeout(r, this.delay));
        return { timestamp: ts, ghi: 500, source: "open-meteo" };
      }
      isHealthy(): boolean { return true; }
    }

    const ensemble = new EnsembleProvider([
      new DelayedProvider("slow1", 100),
      new DelayedProvider("slow2", 100),
      new DelayedProvider("slow3", 100),
    ]);

    const start = Date.now();
    await ensemble.fetch(LAT, LNG, TS);
    const elapsed = Date.now() - start;

    // Sequential would be ~300ms+. Parallel — closer to 100ms.
    // Дозволяємо ~200ms upper bound на slow CI runner.
    expect(elapsed).toBeLessThan(200);
  });
});
