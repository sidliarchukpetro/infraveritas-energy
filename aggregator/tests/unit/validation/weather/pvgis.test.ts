/**
 * PVGISProvider unit tests.
 *
 * Spec: docs/specs/phase4_design.md §11.1.
 *
 * Run via: npm test -- pvgis
 */

import { describe, it, expect } from "vitest";
import { PVGISProvider } from "../../../../src/validation/weather/pvgis.js";
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

function pvgisTimeFromTs(ts: number): string {
  // "YYYYMMDD:HHMM"
  const d = new Date(ts * 1000);
  const yyyy = d.getUTCFullYear().toString();
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mn = d.getUTCMinutes().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}:${hh}${mn}`;
}

const LAT = 48.4517;
const LNG = 25.5752;

// ---------- Happy path ----------

describe("PVGISProvider — happy path", () => {
  it("parses valid response with G(i), Gb(n), Gd(h)", async () => {
    const target = alignedHour(Math.floor(Date.now() / 1000));
    const time = pvgisTimeFromTs(target);

    const fetcher = mockFetcher(async (url) => {
      expect(url).toContain("re.jrc.ec.europa.eu/api/v5_2/seriescalc");
      expect(url).toContain(`lat=${LAT}`);
      expect(url).toContain(`lon=${LNG}`);
      expect(url).toContain("outputformat=json");
      return mockResponse({
        outputs: {
          hourly: [
            { time, "G(i)": 510.5, "Gb(n)": 380.2, "Gd(h)": 130.3 },
          ],
        },
      });
    });

    const provider = new PVGISProvider({ fetcher });
    const point = await provider.fetch(LAT, LNG, target);

    expect(point.source).toBe("pvgis");
    expect(point.ghi).toBe(510.5);
    expect(point.dni).toBe(380.2);
    expect(point.dhi).toBe(130.3);
    expect(point.timestamp).toBe(target);
  });

  it("finds closest entry from multiple hourly entries", async () => {
    const baseHour = alignedHour(Math.floor(Date.now() / 1000));
    const target = baseHour + 15 * 60;
    const time1 = pvgisTimeFromTs(baseHour);
    const time2 = pvgisTimeFromTs(baseHour + 3600);

    const fetcher = mockFetcher(async () =>
      mockResponse({
        outputs: {
          hourly: [
            { time: time1, "G(i)": 400 },
            { time: time2, "G(i)": 500 },
          ],
        },
      }),
    );

    const provider = new PVGISProvider({ fetcher });
    const point = await provider.fetch(LAT, LNG, target);

    expect(point.ghi).toBe(400);
    expect(point.timestamp).toBe(baseHour);
  });

  it("builds correct year-based URL params", async () => {
    const ts = Math.floor(Date.UTC(2025, 6, 1) / 1000); // July 1, 2025

    let calledUrl = "";
    const fetcher = mockFetcher(async (url) => {
      calledUrl = url;
      return mockResponse({
        outputs: { hourly: [{ time: "20250701:1200", "G(i)": 600 }] },
      });
    });

    const provider = new PVGISProvider({ fetcher });
    await provider.fetch(LAT, LNG, ts);
    expect(calledUrl).toContain("startyear=2025");
    expect(calledUrl).toContain("endyear=2025");
  });

  it("handles missing optional DNI/DHI", async () => {
    const target = alignedHour(Math.floor(Date.now() / 1000));
    const time = pvgisTimeFromTs(target);

    const fetcher = mockFetcher(async () =>
      mockResponse({
        outputs: { hourly: [{ time, "G(i)": 300 }] },
      }),
    );

    const provider = new PVGISProvider({ fetcher });
    const point = await provider.fetch(LAT, LNG, target);

    expect(point.ghi).toBe(300);
    expect(point.dni).toBeUndefined();
    expect(point.dhi).toBeUndefined();
  });

  it("isHealthy returns true after successful fetch", async () => {
    const target = alignedHour(Math.floor(Date.now() / 1000));
    const time = pvgisTimeFromTs(target);

    const fetcher = mockFetcher(async () =>
      mockResponse({ outputs: { hourly: [{ time, "G(i)": 100 }] } }),
    );
    const provider = new PVGISProvider({ fetcher });
    await provider.fetch(LAT, LNG, target);
    expect(provider.isHealthy()).toBe(true);
  });
});

// ---------- Error handling ----------

describe("PVGISProvider — error handling", () => {
  it("throws on HTTP 429 і marks unhealthy", async () => {
    const fetcher = mockFetcher(async () => new Response("", { status: 429 }));
    const provider = new PVGISProvider({ fetcher });

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
      return new Response("", { status: 502 });
    });
    const provider = new PVGISProvider({ fetcher });

    await expect(provider.fetch(LAT, LNG, 1700000000)).rejects.toThrow(ProviderError);
    expect(calls).toBe(2);
  });

  it("succeeds on retry if first 5xx, second OK", async () => {
    const target = alignedHour(Math.floor(Date.now() / 1000));
    const time = pvgisTimeFromTs(target);

    let calls = 0;
    const fetcher = mockFetcher(async () => {
      calls++;
      if (calls === 1) return new Response("", { status: 500 });
      return mockResponse({
        outputs: { hourly: [{ time, "G(i)": 250 }] },
      });
    });

    const provider = new PVGISProvider({ fetcher });
    const point = await provider.fetch(LAT, LNG, target);
    expect(point.ghi).toBe(250);
  });

  it("does NOT retry on HTTP 400", async () => {
    let calls = 0;
    const fetcher = mockFetcher(async () => {
      calls++;
      return new Response("", { status: 400 });
    });
    const provider = new PVGISProvider({ fetcher });

    await expect(provider.fetch(LAT, LNG, 1700000000)).rejects.toThrow(ProviderError);
    expect(calls).toBe(1);
  });

  it("throws on HTTP 404 with code='not-found'", async () => {
    const fetcher = mockFetcher(async () => new Response("", { status: 404 }));
    const provider = new PVGISProvider({ fetcher });

    try {
      await provider.fetch(LAT, LNG, 1700000000);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ProviderError).code).toBe("not-found");
    }
  });

  it("throws on empty outputs.hourly", async () => {
    const fetcher = mockFetcher(async () =>
      mockResponse({ outputs: { hourly: [] } }),
    );
    const provider = new PVGISProvider({ fetcher });

    await expect(provider.fetch(LAT, LNG, 1700000000)).rejects.toThrow(
      /missing outputs\.hourly/,
    );
  });

  it("throws on missing outputs.hourly with custom message", async () => {
    const fetcher = mockFetcher(async () =>
      mockResponse({ outputs: {}, message: "Out of solar database coverage" }),
    );
    const provider = new PVGISProvider({ fetcher });

    try {
      await provider.fetch(LAT, LNG, 1700000000);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ProviderError).code).toBe("malformed");
      expect((err as ProviderError).message).toContain("Out of solar database");
    }
  });

  it("throws on malformed time format у hourly entries", async () => {
    const fetcher = mockFetcher(async () =>
      mockResponse({
        outputs: {
          hourly: [
            { time: "garbage-time-format", "G(i)": 100 },
          ],
        },
      }),
    );
    const provider = new PVGISProvider({ fetcher });

    await expect(provider.fetch(LAT, LNG, 1700000000)).rejects.toThrow(
      /no parseable time entries/,
    );
  });

  it("throws on null G(i)", async () => {
    const target = alignedHour(Math.floor(Date.now() / 1000));
    const time = pvgisTimeFromTs(target);

    const fetcher = mockFetcher(async () =>
      mockResponse({
        outputs: { hourly: [{ time, "G(i)": null }] },
      }),
    );
    const provider = new PVGISProvider({ fetcher });

    await expect(provider.fetch(LAT, LNG, target)).rejects.toThrow(/invalid G\(i\)/);
  });

  it("throws on malformed JSON body", async () => {
    const fetcher = mockFetcher(async () => new Response("garbage", { status: 200 }));
    const provider = new PVGISProvider({ fetcher });

    try {
      await provider.fetch(LAT, LNG, 1700000000);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ProviderError).code).toBe("malformed");
    }
  });
});

// ---------- Input validation ----------

describe("PVGISProvider — input validation", () => {
  const fetcher = mockFetcher(async () => mockResponse({}));

  it("rejects out-of-range latitude", async () => {
    const provider = new PVGISProvider({ fetcher });
    await expect(provider.fetch(91, 0, 1700000000)).rejects.toThrow(/invalid lat/);
  });

  it("rejects out-of-range longitude", async () => {
    const provider = new PVGISProvider({ fetcher });
    await expect(provider.fetch(0, -181, 1700000000)).rejects.toThrow(/invalid lng/);
  });

  it("rejects non-positive timestamp", async () => {
    const provider = new PVGISProvider({ fetcher });
    await expect(provider.fetch(0, 0, -1)).rejects.toThrow(/invalid timestamp/);
  });
});

// ---------- Timeout ----------

describe("PVGISProvider — timeout", () => {
  it("throws ProviderError code='network' on abort", async () => {
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

    const provider = new PVGISProvider({ fetcher, timeoutMs: 50 });

    let caught: ProviderError | undefined;
    try {
      await provider.fetch(LAT, LNG, 1700000000);
    } catch (err) {
      caught = err as ProviderError;
    }
    expect(caught?.code).toBe("network");
  });
});
