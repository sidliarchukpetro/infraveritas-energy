/**
 * NASAPowerProvider unit tests.
 *
 * Spec: docs/specs/phase4_design.md §11.1 (analogous до openMeteo.test.ts).
 *
 * Run via: npm test -- nasaPower
 */

import { describe, it, expect } from "vitest";
import { NASAPowerProvider } from "../../../../src/validation/weather/nasaPower.js";
import {
  ProviderError,
  type HttpFetcher,
} from "../../../../src/validation/weather/provider.js";

// ---------- Helpers ----------

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetcher(handler: (url: string) => Promise<Response>): HttpFetcher {
  return ((url, _init) => handler(url.toString())) as HttpFetcher;
}

function alignedHour(ts: number): number {
  return Math.floor(ts / 3600) * 3600;
}

function nasaKeyFromTs(ts: number): string {
  // YYYYMMDDHH
  const d = new Date(ts * 1000);
  const yyyy = d.getUTCFullYear().toString();
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}${hh}`;
}

const LAT = 48.4517;
const LNG = 25.5752;

// ---------- Happy path ----------

describe("NASAPowerProvider — happy path", () => {
  it("parses valid response with ALLSKY_SFC_SW_DWN", async () => {
    const target = alignedHour(Math.floor(Date.now() / 1000));
    const key = nasaKeyFromTs(target);

    const fetcher = mockFetcher(async (url) => {
      expect(url).toContain("power.larc.nasa.gov/api/temporal/hourly/point");
      expect(url).toContain("parameters=ALLSKY_SFC_SW_DWN");
      expect(url).toContain("community=RE");
      expect(url).toContain(`latitude=${LAT}`);
      expect(url).toContain(`longitude=${LNG}`);
      return mockResponse({
        properties: {
          parameter: {
            ALLSKY_SFC_SW_DWN: { [key]: 487.3 },
          },
        },
      });
    });

    const provider = new NASAPowerProvider({ fetcher });
    const point = await provider.fetch(LAT, LNG, target);

    expect(point.source).toBe("nasa-power");
    expect(point.ghi).toBe(487.3);
    expect(point.timestamp).toBe(target);
    expect(point.dni).toBeUndefined();
    expect(point.dhi).toBeUndefined();
    expect(point.cloudCover).toBeUndefined();
  });

  it("finds closest hour from multiple entries", async () => {
    const baseHour = alignedHour(Math.floor(Date.now() / 1000));
    const target = baseHour + 15 * 60;
    const key1 = nasaKeyFromTs(baseHour);
    const key2 = nasaKeyFromTs(baseHour + 3600);

    const fetcher = mockFetcher(async () =>
      mockResponse({
        properties: {
          parameter: {
            ALLSKY_SFC_SW_DWN: { [key1]: 400, [key2]: 500 },
          },
        },
      }),
    );

    const provider = new NASAPowerProvider({ fetcher });
    const point = await provider.fetch(LAT, LNG, target);

    expect(point.ghi).toBe(400);
    expect(point.timestamp).toBe(baseHour);
  });

  it("builds correct YYYYMMDD date format у URL", async () => {
    const ts = Math.floor(Date.UTC(2026, 4, 15, 12, 0, 0) / 1000); // 2026-05-15 12:00

    let calledUrl = "";
    const fetcher = mockFetcher(async (url) => {
      calledUrl = url;
      return mockResponse({
        properties: { parameter: { ALLSKY_SFC_SW_DWN: { "2026051512": 400 } } },
      });
    });

    const provider = new NASAPowerProvider({ fetcher });
    await provider.fetch(LAT, LNG, ts);
    expect(calledUrl).toContain("start=20260515");
    expect(calledUrl).toContain("end=20260515");
  });

  it("isHealthy returns true after successful fetch", async () => {
    const ts = alignedHour(Math.floor(Date.now() / 1000));
    const key = nasaKeyFromTs(ts);
    const fetcher = mockFetcher(async () =>
      mockResponse({
        properties: { parameter: { ALLSKY_SFC_SW_DWN: { [key]: 200 } } },
      }),
    );
    const provider = new NASAPowerProvider({ fetcher });
    await provider.fetch(LAT, LNG, ts);
    expect(provider.isHealthy()).toBe(true);
  });
});

// ---------- Error handling ----------

describe("NASAPowerProvider — error handling", () => {
  it("throws ProviderError code='malformed' on missing data marker -999", async () => {
    const ts = alignedHour(Math.floor(Date.now() / 1000));
    const key = nasaKeyFromTs(ts);

    const fetcher = mockFetcher(async () =>
      mockResponse({
        properties: { parameter: { ALLSKY_SFC_SW_DWN: { [key]: -999 } } },
      }),
    );
    const provider = new NASAPowerProvider({ fetcher });

    let caught: ProviderError | undefined;
    try {
      await provider.fetch(LAT, LNG, ts);
    } catch (err) {
      caught = err as ProviderError;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught?.code).toBe("malformed");
    expect(caught?.message).toContain("-999");
  });

  it("throws на HTTP 429 (rate limit) і marks unhealthy", async () => {
    const fetcher = mockFetcher(async () => new Response("", { status: 429 }));
    const provider = new NASAPowerProvider({ fetcher });

    let caught: ProviderError | undefined;
    try {
      await provider.fetch(LAT, LNG, 1700000000);
    } catch (err) {
      caught = err as ProviderError;
    }
    expect(caught?.code).toBe("rate-limit");
    expect(provider.isHealthy()).toBe(false);
  });

  it("retries once on HTTP 5xx", async () => {
    let calls = 0;
    const fetcher = mockFetcher(async () => {
      calls++;
      return new Response("", { status: 503 });
    });
    const provider = new NASAPowerProvider({ fetcher });

    await expect(provider.fetch(LAT, LNG, 1700000000)).rejects.toThrow(ProviderError);
    expect(calls).toBe(2);
  });

  it("succeeds on retry if first returns 5xx, second OK", async () => {
    const ts = alignedHour(Math.floor(Date.now() / 1000));
    const key = nasaKeyFromTs(ts);

    let calls = 0;
    const fetcher = mockFetcher(async () => {
      calls++;
      if (calls === 1) return new Response("", { status: 500 });
      return mockResponse({
        properties: { parameter: { ALLSKY_SFC_SW_DWN: { [key]: 333 } } },
      });
    });

    const provider = new NASAPowerProvider({ fetcher });
    const point = await provider.fetch(LAT, LNG, ts);
    expect(point.ghi).toBe(333);
    expect(calls).toBe(2);
  });

  it("does NOT retry on HTTP 4xx (except 429)", async () => {
    let calls = 0;
    const fetcher = mockFetcher(async () => {
      calls++;
      return new Response("", { status: 400 });
    });
    const provider = new NASAPowerProvider({ fetcher });

    await expect(provider.fetch(LAT, LNG, 1700000000)).rejects.toThrow(ProviderError);
    expect(calls).toBe(1);
  });

  it("throws ProviderError code='not-found' on HTTP 404", async () => {
    const fetcher = mockFetcher(async () => new Response("", { status: 404 }));
    const provider = new NASAPowerProvider({ fetcher });

    try {
      await provider.fetch(LAT, LNG, 1700000000);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ProviderError).code).toBe("not-found");
    }
  });

  it("throws on API errors[] array", async () => {
    const fetcher = mockFetcher(async () =>
      mockResponse({ errors: ["Invalid coordinates", "Out of range"] }),
    );
    const provider = new NASAPowerProvider({ fetcher });

    try {
      await provider.fetch(LAT, LNG, 1700000000);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ProviderError).code).toBe("malformed");
      expect((err as ProviderError).message).toContain("Invalid coordinates");
    }
  });

  it("throws on missing properties.parameter.ALLSKY_SFC_SW_DWN", async () => {
    const fetcher = mockFetcher(async () =>
      mockResponse({ properties: { parameter: {} } }),
    );
    const provider = new NASAPowerProvider({ fetcher });

    await expect(provider.fetch(LAT, LNG, 1700000000)).rejects.toThrow(
      /missing ALLSKY_SFC_SW_DWN/,
    );
  });

  it("throws on malformed JSON body", async () => {
    const fetcher = mockFetcher(
      async () => new Response("not json", { status: 200 }),
    );
    const provider = new NASAPowerProvider({ fetcher });

    try {
      await provider.fetch(LAT, LNG, 1700000000);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ProviderError).code).toBe("malformed");
    }
  });
});

// ---------- Input validation ----------

describe("NASAPowerProvider — input validation", () => {
  const fetcher = mockFetcher(async () => mockResponse({}));

  it("rejects out-of-range latitude", async () => {
    const provider = new NASAPowerProvider({ fetcher });
    await expect(provider.fetch(91, 0, 1700000000)).rejects.toThrow(/invalid lat/);
    await expect(provider.fetch(NaN, 0, 1700000000)).rejects.toThrow(/invalid lat/);
  });

  it("rejects out-of-range longitude", async () => {
    const provider = new NASAPowerProvider({ fetcher });
    await expect(provider.fetch(0, 181, 1700000000)).rejects.toThrow(/invalid lng/);
  });

  it("rejects non-positive timestamp", async () => {
    const provider = new NASAPowerProvider({ fetcher });
    await expect(provider.fetch(0, 0, 0)).rejects.toThrow(/invalid timestamp/);
    await expect(provider.fetch(0, 0, -1)).rejects.toThrow(/invalid timestamp/);
  });
});

// ---------- Timeout ----------

describe("NASAPowerProvider — timeout", () => {
  it("throws ProviderError code='network' on AbortError (timeout)", async () => {
    const fetcher: HttpFetcher = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });

    const provider = new NASAPowerProvider({ fetcher, timeoutMs: 50 });

    let caught: ProviderError | undefined;
    try {
      await provider.fetch(LAT, LNG, 1700000000);
    } catch (err) {
      caught = err as ProviderError;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught?.code).toBe("network");
    expect(caught?.message).toContain("timeout");
  });
});
