/**
 * OpenMeteoProvider unit tests.
 *
 * Spec: docs/specs/phase4_design.md §11.1.
 *
 * Tests use DI'd HttpFetcher — no real network calls, no global fetch
 * monkey-patching. Run via: `npm test` (vitest).
 *
 * Covers:
 *   - Happy path: forecast і archive routing
 *   - Closest-point selection across multiple hours
 *   - Error handling: 429 (rate limit), 5xx (retry), 4xx (no retry),
 *     malformed JSON, API error body, null GHI, invalid inputs, timeout
 *   - Health state transitions
 */

import { describe, it, expect } from "vitest";
import { OpenMeteoProvider } from "../../../../src/validation/weather/openMeteo.js";
import {
  ProviderError,
  type HttpFetcher,
} from "../../../../src/validation/weather/provider.js";

// ---------- Test helpers ----------

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

function isoHourString(ts: number): string {
  // Open-Meteo формат: "2026-05-15T12:00" (без Z, без seconds)
  return new Date(ts * 1000).toISOString().slice(0, 16);
}

// Sniatyn coordinates (тестовий пристрій per continuation brief)
const LAT = 48.4517;
const LNG = 25.5752;

// ---------- Happy path ----------

describe("OpenMeteoProvider — happy path", () => {
  it("parses current-hour forecast response", async () => {
    const target = alignedHour(Math.floor(Date.now() / 1000));
    const iso = isoHourString(target);

    const fetcher = mockFetcher(async (url) => {
      expect(url).toContain("api.open-meteo.com/v1/forecast");
      expect(url).toContain(`latitude=${LAT}`);
      expect(url).toContain(`longitude=${LNG}`);
      expect(url).toContain("hourly=shortwave_radiation");
      return mockResponse({
        hourly: {
          time: [iso],
          shortwave_radiation: [542.3],
          direct_radiation: [400.1],
          diffuse_radiation: [142.2],
          cloud_cover: [15],
        },
      });
    });

    const provider = new OpenMeteoProvider({ fetcher });
    const point = await provider.fetch(LAT, LNG, target);

    expect(point.source).toBe("open-meteo");
    expect(point.ghi).toBe(542.3);
    expect(point.dni).toBe(400.1);
    expect(point.dhi).toBe(142.2);
    expect(point.cloudCover).toBe(15);
    expect(point.timestamp).toBe(target);
  });

  it("routes to archive endpoint для historical timestamps (>14 днів)", async () => {
    const old = alignedHour(Math.floor(Date.now() / 1000) - 30 * 24 * 3600);
    const iso = isoHourString(old);

    let calledUrl = "";
    const fetcher = mockFetcher(async (url) => {
      calledUrl = url;
      return mockResponse({
        hourly: { time: [iso], shortwave_radiation: [320.5] },
      });
    });

    const provider = new OpenMeteoProvider({ fetcher });
    const point = await provider.fetch(LAT, LNG, old);

    expect(calledUrl).toContain("archive-api.open-meteo.com/v1/archive");
    expect(calledUrl).not.toContain("api.open-meteo.com/v1/forecast");
    expect(point.ghi).toBe(320.5);
  });

  it("uses forecast endpoint для timestamps молодших за 14 днів", async () => {
    const recent = alignedHour(Math.floor(Date.now() / 1000) - 3 * 24 * 3600);
    const iso = isoHourString(recent);

    let calledUrl = "";
    const fetcher = mockFetcher(async (url) => {
      calledUrl = url;
      return mockResponse({
        hourly: { time: [iso], shortwave_radiation: [410] },
      });
    });

    const provider = new OpenMeteoProvider({ fetcher });
    await provider.fetch(LAT, LNG, recent);

    expect(calledUrl).toContain("api.open-meteo.com/v1/forecast");
  });

  it("finds closest point when API returns multiple hours", async () => {
    // target at HH:15, response has HH:00 and (HH+1):00 — HH:00 ближче (15min vs 45min)
    const baseHour = alignedHour(Math.floor(Date.now() / 1000));
    const target = baseHour + 15 * 60;
    const isoBase = isoHourString(baseHour);
    const isoNext = isoHourString(baseHour + 3600);

    const fetcher = mockFetcher(async () =>
      mockResponse({
        hourly: {
          time: [isoBase, isoNext],
          shortwave_radiation: [500, 600],
        },
      }),
    );

    const provider = new OpenMeteoProvider({ fetcher });
    const point = await provider.fetch(LAT, LNG, target);

    expect(point.ghi).toBe(500);
    expect(point.timestamp).toBe(baseHour);
  });

  it("handles missing optional fields gracefully", async () => {
    const ts = alignedHour(Math.floor(Date.now() / 1000));
    const iso = isoHourString(ts);

    const fetcher = mockFetcher(async () =>
      mockResponse({
        hourly: { time: [iso], shortwave_radiation: [200] },
        // no direct_radiation, diffuse_radiation, cloud_cover
      }),
    );

    const provider = new OpenMeteoProvider({ fetcher });
    const point = await provider.fetch(LAT, LNG, ts);

    expect(point.ghi).toBe(200);
    expect(point.dni).toBeUndefined();
    expect(point.dhi).toBeUndefined();
    expect(point.cloudCover).toBeUndefined();
  });

  it("isHealthy returns true after successful fetch", async () => {
    const ts = alignedHour(Math.floor(Date.now() / 1000));
    const iso = isoHourString(ts);

    const fetcher = mockFetcher(async () =>
      mockResponse({ hourly: { time: [iso], shortwave_radiation: [100] } }),
    );
    const provider = new OpenMeteoProvider({ fetcher });
    await provider.fetch(LAT, LNG, ts);
    expect(provider.isHealthy()).toBe(true);
  });
});

// ---------- Error handling ----------

describe("OpenMeteoProvider — error handling", () => {
  it("throws ProviderError на HTTP 429 (rate limit) і marks unhealthy", async () => {
    const fetcher = mockFetcher(async () => new Response("", { status: 429 }));
    const provider = new OpenMeteoProvider({ fetcher });

    let caught: ProviderError | undefined;
    try {
      await provider.fetch(LAT, LNG, 1700000000);
    } catch (err) {
      caught = err as ProviderError;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught?.code).toBe("rate-limit");
    expect(provider.isHealthy()).toBe(false);
  });

  it("retries once на HTTP 5xx, throws якщо все ще fails", async () => {
    let calls = 0;
    const fetcher = mockFetcher(async () => {
      calls++;
      return new Response("", { status: 500 });
    });

    const provider = new OpenMeteoProvider({ fetcher });
    await expect(provider.fetch(LAT, LNG, 1700000000)).rejects.toThrow(ProviderError);
    expect(calls).toBe(2); // initial + 1 retry
  });

  it("succeeds на retry якщо first call returns 5xx, second OK", async () => {
    const ts = alignedHour(Math.floor(Date.now() / 1000));
    const iso = isoHourString(ts);

    let calls = 0;
    const fetcher = mockFetcher(async () => {
      calls++;
      if (calls === 1) return new Response("", { status: 503 });
      return mockResponse({ hourly: { time: [iso], shortwave_radiation: [333] } });
    });

    const provider = new OpenMeteoProvider({ fetcher });
    const point = await provider.fetch(LAT, LNG, ts);
    expect(point.ghi).toBe(333);
    expect(calls).toBe(2);
  });

  it("does NOT retry на HTTP 4xx (крім 429)", async () => {
    let calls = 0;
    const fetcher = mockFetcher(async () => {
      calls++;
      return new Response("", { status: 400 });
    });

    const provider = new OpenMeteoProvider({ fetcher });
    await expect(provider.fetch(LAT, LNG, 1700000000)).rejects.toThrow(ProviderError);
    expect(calls).toBe(1);
  });

  it("throws ProviderError code='not-found' на HTTP 404", async () => {
    const fetcher = mockFetcher(async () => new Response("", { status: 404 }));
    const provider = new OpenMeteoProvider({ fetcher });

    try {
      await provider.fetch(LAT, LNG, 1700000000);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe("not-found");
    }
  });

  it("throws ProviderError code='malformed' на invalid JSON body", async () => {
    const fetcher = mockFetcher(
      async () => new Response("not json at all", { status: 200 }),
    );
    const provider = new OpenMeteoProvider({ fetcher });

    try {
      await provider.fetch(LAT, LNG, 1700000000);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe("malformed");
    }
  });

  it("throws на API error response (body.error=true)", async () => {
    const fetcher = mockFetcher(async () =>
      mockResponse({ error: true, reason: "Latitude must be between -90 and 90" }),
    );
    const provider = new OpenMeteoProvider({ fetcher });

    try {
      await provider.fetch(LAT, LNG, 1700000000);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ProviderError).code).toBe("malformed");
      expect((err as ProviderError).message).toContain("Latitude must be");
    }
  });

  it("throws на null GHI у response", async () => {
    const ts = alignedHour(Math.floor(Date.now() / 1000));
    const iso = isoHourString(ts);

    const fetcher = mockFetcher(async () =>
      mockResponse({ hourly: { time: [iso], shortwave_radiation: [null] } }),
    );
    const provider = new OpenMeteoProvider({ fetcher });

    await expect(provider.fetch(LAT, LNG, ts)).rejects.toThrow(/null GHI/);
  });

  it("throws на empty hourly.time", async () => {
    const fetcher = mockFetcher(async () =>
      mockResponse({ hourly: { time: [], shortwave_radiation: [] } }),
    );
    const provider = new OpenMeteoProvider({ fetcher });

    await expect(provider.fetch(LAT, LNG, 1700000000)).rejects.toThrow(/empty hourly\.time/);
  });
});

// ---------- Input validation ----------

describe("OpenMeteoProvider — input validation", () => {
  // Need fetcher even if not called — buildUrl runs after validation
  const fetcher = mockFetcher(async () => mockResponse({}));

  it("rejects out-of-range latitude", async () => {
    const provider = new OpenMeteoProvider({ fetcher });
    await expect(provider.fetch(91, 0, 1700000000)).rejects.toThrow(/invalid lat/);
    await expect(provider.fetch(-91, 0, 1700000000)).rejects.toThrow(/invalid lat/);
  });

  it("rejects NaN/Infinity latitude", async () => {
    const provider = new OpenMeteoProvider({ fetcher });
    await expect(provider.fetch(NaN, 0, 1700000000)).rejects.toThrow(/invalid lat/);
    await expect(provider.fetch(Infinity, 0, 1700000000)).rejects.toThrow(/invalid lat/);
  });

  it("rejects out-of-range longitude", async () => {
    const provider = new OpenMeteoProvider({ fetcher });
    await expect(provider.fetch(0, 181, 1700000000)).rejects.toThrow(/invalid lng/);
    await expect(provider.fetch(0, -181, 1700000000)).rejects.toThrow(/invalid lng/);
  });

  it("rejects non-positive timestamp", async () => {
    const provider = new OpenMeteoProvider({ fetcher });
    await expect(provider.fetch(0, 0, 0)).rejects.toThrow(/invalid timestamp/);
    await expect(provider.fetch(0, 0, -1)).rejects.toThrow(/invalid timestamp/);
  });
});

// ---------- Timeout handling ----------

describe("OpenMeteoProvider — timeout", () => {
  it("throws ProviderError code='network' on AbortError (timeout)", async () => {
    const fetcher: HttpFetcher = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        // Simulate slow API — react to abort signal
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const abortErr = new Error("aborted");
            abortErr.name = "AbortError";
            reject(abortErr);
          });
        }
      });

    const provider = new OpenMeteoProvider({ fetcher, timeoutMs: 50 });

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
