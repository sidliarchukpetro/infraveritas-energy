/**
 * NASAPowerProvider — NASA POWER Surface Shortwave Downward Irradiance.
 *
 * Spec: docs/specs/phase4_design.md §4.2.
 *
 * Endpoint: https://power.larc.nasa.gov/api/temporal/hourly/point
 *
 * Parameter: ALLSKY_SFC_SW_DWN (All Sky Surface Shortwave Downward Irradiance)
 *   — GHI у W/m² усереднена по hour.
 *
 * No API key required. Rate limit ~30 req/min/IP.
 * Spatial resolution: 0.5° (~55 km) — найгрубша з трьох.
 * Historical data з 1984 — найдовша глибина.
 *
 * Missing data marker: NASA повертає -999 для відсутніх values.
 * Treat as null — throw ProviderError(malformed).
 *
 * URL date format: YYYYMMDD (e.g. "20260515")
 * Output keys format: YYYYMMDDHH (e.g. "2026051512" для 12:00 UTC 15 May 2026)
 */

import {
  type HttpFetcher,
  type IrradiancePoint,
  type IrradianceProvider,
  ProviderError,
} from "./provider.js";

const ENDPOINT = "https://power.larc.nasa.gov/api/temporal/hourly/point";
const MISSING_DATA = -999;

const DEFAULT_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 500;
const USER_AGENT = "infraveritas-aggregator/0.1 (+https://infraveritas.pro)";

interface NASAPowerResponse {
  properties?: {
    parameter?: {
      ALLSKY_SFC_SW_DWN?: Record<string, number>;
    };
  };
  messages?: string[];
  errors?: string[];
}

export interface NASAPowerOptions {
  fetcher?: HttpFetcher;
  timeoutMs?: number;
}

export class NASAPowerProvider implements IrradianceProvider {
  public readonly name = "nasa-power";

  private readonly fetcher: HttpFetcher;
  private readonly timeoutMs: number;
  private healthy = true;

  constructor(opts: NASAPowerOptions = {}) {
    this.fetcher = opts.fetcher ?? (globalThis.fetch as HttpFetcher);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async fetch(lat: number, lng: number, timestamp: number): Promise<IrradiancePoint> {
    this.validateInputs(lat, lng, timestamp);
    const url = this.buildUrl(lat, lng, timestamp);

    const response = await this.fetchWithRetry(url);

    if (response.status === 429) {
      this.healthy = false;
      throw new ProviderError(this.name, "rate-limit", `HTTP 429 from ${url}`);
    }

    if (response.status === 404) {
      throw new ProviderError(this.name, "not-found", `HTTP 404 from ${url}`);
    }

    if (!response.ok) {
      this.healthy = false;
      throw new ProviderError(
        this.name,
        "network",
        `HTTP ${response.status} from ${url}`,
      );
    }

    let body: NASAPowerResponse;
    try {
      body = (await response.json()) as NASAPowerResponse;
    } catch (err) {
      throw new ProviderError(this.name, "malformed", "JSON parse failed", err);
    }

    if (body.errors && body.errors.length > 0) {
      throw new ProviderError(
        this.name,
        "malformed",
        `API errors: ${body.errors.join("; ")}`,
      );
    }

    const series = body.properties?.parameter?.ALLSKY_SFC_SW_DWN;
    if (!series || Object.keys(series).length === 0) {
      throw new ProviderError(
        this.name,
        "malformed",
        "missing ALLSKY_SFC_SW_DWN parameter in response",
      );
    }

    const point = this.findClosestPoint(series, timestamp);
    this.healthy = true;
    return point;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  // ---------- Private ----------

  private validateInputs(lat: number, lng: number, timestamp: number): void {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new ProviderError(this.name, "malformed", `invalid lat: ${lat}`);
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new ProviderError(this.name, "malformed", `invalid lng: ${lng}`);
    }
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      throw new ProviderError(
        this.name,
        "malformed",
        `invalid timestamp: ${timestamp}`,
      );
    }
  }

  private buildUrl(lat: number, lng: number, timestamp: number): string {
    const date = formatYYYYMMDD(timestamp);
    const params = new URLSearchParams({
      parameters: "ALLSKY_SFC_SW_DWN",
      community: "RE",
      latitude: lat.toString(),
      longitude: lng.toString(),
      start: date,
      end: date,
      format: "JSON",
    });
    return `${ENDPOINT}?${params.toString()}`;
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    try {
      let response = await this.fetchWithTimeout(url);

      if (response.status >= 500 && response.status < 600) {
        await sleep(RETRY_DELAY_MS);
        response = await this.fetchWithTimeout(url);
      }
      return response;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      this.healthy = false;
      throw new ProviderError(
        this.name,
        "network",
        err instanceof Error ? err.message : String(err),
        err,
      );
    }
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await this.fetcher(url, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        throw new ProviderError(
          this.name,
          "network",
          `timeout after ${this.timeoutMs}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private findClosestPoint(
    series: Record<string, number>,
    targetTs: number,
  ): IrradiancePoint {
    const keys = Object.keys(series);
    if (keys.length === 0) {
      throw new ProviderError(this.name, "malformed", "empty series");
    }

    let closestKey: string | undefined = undefined;
    let closestDelta = Infinity;
    let closestTs = 0;

    for (const key of keys) {
      const ts = parseNasaKey(key);
      if (ts === null) continue;
      const delta = Math.abs(ts - targetTs);
      if (delta < closestDelta) {
        closestDelta = delta;
        closestKey = key;
        closestTs = ts;
      }
    }

    if (closestKey === undefined) {
      throw new ProviderError(
        this.name,
        "malformed",
        "no parseable keys у series (expected YYYYMMDDHH format)",
      );
    }

    const value = series[closestKey];
    if (value === MISSING_DATA || value === null || value === undefined) {
      throw new ProviderError(
        this.name,
        "malformed",
        `missing/invalid GHI value at key ${closestKey} (${value})`,
      );
    }

    return {
      timestamp: closestTs,
      ghi: value,
      source: "nasa-power",
    };
  }
}

// ---------- Free helpers ----------

function parseNasaKey(key: string): number | null {
  // Format: YYYYMMDDHH (10 digits)
  if (!/^\d{10}$/.test(key)) return null;
  const year = parseInt(key.slice(0, 4), 10);
  const month = parseInt(key.slice(4, 6), 10) - 1; // 0-indexed
  const day = parseInt(key.slice(6, 8), 10);
  const hour = parseInt(key.slice(8, 10), 10);
  return Math.floor(Date.UTC(year, month, day, hour, 0, 0) / 1000);
}

function formatYYYYMMDD(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const yyyy = d.getUTCFullYear().toString();
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
