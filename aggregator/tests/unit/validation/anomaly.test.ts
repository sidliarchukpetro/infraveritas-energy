/**
 * AnomalyEvaluator unit tests.
 *
 * Spec: docs/specs/phase4_design.md §11.4.
 *
 * Pure function — no IO, no mocks needed. Run via: npm test -- anomaly
 */

import { describe, it, expect } from "vitest";
import {
  evaluateAnomaly,
  type AnomalyInputPayload,
  type DriftSummary,
} from "../../../src/validation/anomaly.js";
import type { EnsembleResult } from "../../../src/validation/weather/ensemble.js";

// ---------- Test data factories ----------

function makePayload(
  overrides: Partial<AnomalyInputPayload> = {},
): AnomalyInputPayload {
  return {
    tamper_flag: 0n,
    total_energy_mwh: 50000n,
    ...overrides,
  };
}

function makeEnsemble(overrides: Partial<EnsembleResult> = {}): EnsembleResult {
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

function noDrift(): DriftSummary {
  return { drift: false, magnitude: 0 };
}

// ---------- Clean submission ----------

describe("evaluateAnomaly — clean submission", () => {
  it("returns empty flags коли все OK", () => {
    const result = evaluateAnomaly(makePayload(), makeEnsemble(), 0.5, noDrift());
    expect(result.flags).toEqual([]);
    expect(result.reviewRequired).toBe(false);
  });

  it("accepts null zscore (cold start) без flag", () => {
    const result = evaluateAnomaly(makePayload(), makeEnsemble(), null, noDrift());
    expect(result.flags).toEqual([]);
  });

  it("accepts moderate zscore у межах threshold", () => {
    const result = evaluateAnomaly(makePayload(), makeEnsemble(), 2.5, noDrift());
    expect(result.flags).toEqual([]);
  });
});

// ---------- Tamper flag (high severity) ----------

describe("evaluateAnomaly — tamper flag", () => {
  it("flags tamper_flag_set коли payload tamper_flag non-zero", () => {
    const result = evaluateAnomaly(
      makePayload({ tamper_flag: 1n }),
      makeEnsemble(),
      0,
      noDrift(),
    );
    expect(result.flags).toContain("tamper_flag_set");
    expect(result.reviewRequired).toBe(true);
  });

  it("не flag для tamper_flag === 0n", () => {
    const result = evaluateAnomaly(
      makePayload({ tamper_flag: 0n }),
      makeEnsemble(),
      0,
      noDrift(),
    );
    expect(result.flags).not.toContain("tamper_flag_set");
  });
});

// ---------- Weather divergence ----------

describe("evaluateAnomaly — weather source status", () => {
  it("flags divergent_weather_sources коли ensemble.status === 'divergent'", () => {
    const result = evaluateAnomaly(
      makePayload(),
      makeEnsemble({ status: "divergent" }),
      0,
      noDrift(),
    );
    expect(result.flags).toContain("divergent_weather_sources");
    expect(result.reviewRequired).toBe(false); // не high-severity
  });

  it("flags weather_unavailable коли ensemble.status === 'unavailable'", () => {
    const result = evaluateAnomaly(
      makePayload(),
      makeEnsemble({ status: "unavailable", ghi: 0, providersResponded: 0 }),
      0,
      noDrift(),
    );
    expect(result.flags).toContain("weather_unavailable");
    expect(result.reviewRequired).toBe(false);
  });

  it("не flag weather для 'ok' status", () => {
    const result = evaluateAnomaly(
      makePayload(),
      makeEnsemble({ status: "ok" }),
      0,
      noDrift(),
    );
    expect(result.flags).not.toContain("divergent_weather_sources");
    expect(result.flags).not.toContain("weather_unavailable");
  });

  it("не flag weather для 'degraded' status (1 provider OK)", () => {
    const result = evaluateAnomaly(
      makePayload(),
      makeEnsemble({
        status: "degraded",
        providersResponded: 1,
        stdDev: undefined,
        relativeDivergence: undefined,
      }),
      0,
      noDrift(),
    );
    expect(result.flags).not.toContain("divergent_weather_sources");
    expect(result.flags).not.toContain("weather_unavailable");
  });
});

// ---------- Energy inconsistency (high severity) ----------

describe("evaluateAnomaly — energy inconsistency з weather", () => {
  it("flags нічну генерацію (низький GHI + claim of energy)", () => {
    const result = evaluateAnomaly(
      makePayload({ total_energy_mwh: 5000n }),
      makeEnsemble({ ghi: 0, status: "ok" }),
      0,
      noDrift(),
    );
    expect(result.flags).toContain("energy_inconsistent_with_weather");
    expect(result.reviewRequired).toBe(true); // high-severity
  });

  it("не flag коли GHI low але energy claim теж low (noise tolerance)", () => {
    const result = evaluateAnomaly(
      makePayload({ total_energy_mwh: 50n }), // < 100 threshold
      makeEnsemble({ ghi: 0, status: "ok" }),
      0,
      noDrift(),
    );
    expect(result.flags).not.toContain("energy_inconsistent_with_weather");
  });

  it("не flag коли GHI moderate (panel у тіні — valid)", () => {
    const result = evaluateAnomaly(
      makePayload({ total_energy_mwh: 5000n }),
      makeEnsemble({ ghi: 200, status: "ok" }),
      0,
      noDrift(),
    );
    expect(result.flags).not.toContain("energy_inconsistent_with_weather");
  });

  it("НЕ оцінює energy consistency коли ensemble.status === 'divergent'", () => {
    // Не trust ensemble.ghi якщо providers розходяться
    const result = evaluateAnomaly(
      makePayload({ total_energy_mwh: 5000n }),
      makeEnsemble({ ghi: 0, status: "divergent" }),
      0,
      noDrift(),
    );
    expect(result.flags).not.toContain("energy_inconsistent_with_weather");
    expect(result.flags).toContain("divergent_weather_sources");
  });

  it("НЕ оцінює energy consistency коли ensemble.status === 'unavailable'", () => {
    const result = evaluateAnomaly(
      makePayload({ total_energy_mwh: 5000n }),
      makeEnsemble({ ghi: 0, status: "unavailable", providersResponded: 0 }),
      0,
      noDrift(),
    );
    expect(result.flags).not.toContain("energy_inconsistent_with_weather");
    expect(result.flags).toContain("weather_unavailable");
  });
});

// ---------- Z-score outlier ----------

describe("evaluateAnomaly — z-score outlier", () => {
  it("flags energy_zscore_high для z > 3.0", () => {
    const result = evaluateAnomaly(makePayload(), makeEnsemble(), 4.5, noDrift());
    expect(result.flags).toContain("energy_zscore_high");
    expect(result.reviewRequired).toBe(false); // не high-severity
  });

  it("flags для z < -3.0 (lower outlier)", () => {
    const result = evaluateAnomaly(makePayload(), makeEnsemble(), -4.5, noDrift());
    expect(result.flags).toContain("energy_zscore_high");
  });

  it("не flag для |z| === 3.0 (границя — strict >)", () => {
    const result = evaluateAnomaly(makePayload(), makeEnsemble(), 3.0, noDrift());
    expect(result.flags).not.toContain("energy_zscore_high");
  });

  it("не flag коли zscore null (cold start)", () => {
    const result = evaluateAnomaly(makePayload(), makeEnsemble(), null, noDrift());
    expect(result.flags).not.toContain("energy_zscore_high");
  });
});

// ---------- Drift ----------

describe("evaluateAnomaly — drift", () => {
  it("flags drift_detected коли drift.drift === true", () => {
    const result = evaluateAnomaly(
      makePayload(),
      makeEnsemble(),
      0,
      { drift: true, magnitude: 3.5 },
    );
    expect(result.flags).toContain("drift_detected");
    expect(result.reviewRequired).toBe(false);
  });

  it("не flag коли drift.drift === false", () => {
    const result = evaluateAnomaly(makePayload(), makeEnsemble(), 0, noDrift());
    expect(result.flags).not.toContain("drift_detected");
  });
});

// ---------- Multiple flags ----------

describe("evaluateAnomaly — multiple flags одночасно", () => {
  it("collects всі applicable flags", () => {
    const result = evaluateAnomaly(
      makePayload({ tamper_flag: 1n, total_energy_mwh: 5000n }),
      makeEnsemble({ ghi: 0, status: "ok" }),
      4.0,
      { drift: true, magnitude: 3.5 },
    );

    expect(result.flags).toContain("tamper_flag_set");
    expect(result.flags).toContain("energy_inconsistent_with_weather");
    expect(result.flags).toContain("energy_zscore_high");
    expect(result.flags).toContain("drift_detected");
    expect(result.reviewRequired).toBe(true); // tamper + inconsistency — high-sev
  });

  it("reviewRequired=true якщо хоч один high-severity flag", () => {
    const result = evaluateAnomaly(
      makePayload({ tamper_flag: 1n }),
      makeEnsemble({ status: "divergent" }),
      0,
      noDrift(),
    );
    expect(result.flags).toHaveLength(2); // tamper + divergent
    expect(result.reviewRequired).toBe(true); // tamper тригерить
  });

  it("reviewRequired=false якщо тільки low-severity flags", () => {
    const result = evaluateAnomaly(
      makePayload(),
      makeEnsemble({ status: "divergent" }),
      4.0,
      { drift: true, magnitude: 3 },
    );
    expect(result.flags).toHaveLength(3); // divergent + zscore + drift
    expect(result.reviewRequired).toBe(false); // нічого high-severity
  });
});
