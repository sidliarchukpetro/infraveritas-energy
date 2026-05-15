/**
 * OpenMeteoProvider — Open-Meteo Solar Radiation API integration.
 *
 * Spec: docs/specs/phase4_design.md §4.1.
 *
 * Endpoints:
 *   - Recent (within ~14 days):  https://api.open-meteo.com/v1/forecast
 *   - Historical (older):        https://archive-api.open-meteo.com/v1/archive
 *
 * No API key required. Rate limit ~10000 calls/day/IP (free tier).
 *
 * Provider routes internally based on timestamp age. Caller uses single
 * fetch() method для current і historical — це contract of IrradianceProvider.
 *
 * Implementation notes:
 *   - 5s timeout per request (configurable)
 *   - One retry на 5xx або timeout, без retry на 4xx
 *   - User-Agent identifies infraveritas для маркування трафіку
 *   - DI'd HttpFetcher для clean unit testing (no global fetch monkey-patching)
 */

import {
  type HttpFetcher,
  type IrradiancePoint,
  type IrradianceProvider,
  ProviderError,
} from "./provider.js";

// ---------- Constants ----------

const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_BASE = "https://archive-api.open-meteo.com/v1/archive";

/** Routing threshold: timestamps older за 14 днів йдуть в archive. */
const FORECAST_HORIZON_S = 14 * 24 * 3600;

const DEFAULT_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 500;
const USER_AGENT = "infraveritas-aggregator/0.1 (+https://infraveritas.pro)";

// ---------- API response shape ----------

interface OpenMeteoHourly {
  time: string[];
  shortwave_radiation: (number | null)[];
  direct_radiation?: (number | null)[];
  diffuse_radiation?: (number | null)[];
  cloud_cover?: (number | null)[];
}

interface OpenMeteoResponse {
  hourly?: OpenMeteoHourly;
  reason?: string;
  error?: boolean;
}

// ---------- Provider ----------

export interface OpenMeteoOptions {
  /** Custom HTTP fetcher (default: global fetch). DI hook для testing. */
  fetcher?: HttpFetcher;
  /** Request timeout у ms (default 5000). */
  timeoutMs?: number;
}

export class OpenMeteoProvider implements IrradianceProvider {
  public readonly name = "open-meteo";

  private readonly fetcher: HttpFetcher;
  private readonly timeoutMs: number;
  private healthy = true;

  constructor(opts: OpenMeteoOptions = {}) {
    this.fetcher = opts.fetcher ?? (globalThis.fetch as HttpFetcher);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async fetch(lat: number, lng: number, timestamp: number): Promise<IrradiancePoint> {
    this.validateInputs(lat, lng, timestamp);

    const nowS = Math.floor(Date.now() / 1000);
    const ageS = nowS - timestamp;
    const useArchive = ageS > FORECAST_HORIZON_S;
    const url = this.buildUrl(useArchive, lat, lng, timestamp);

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

    let body: OpenMeteoResponse;
    try {
      body = (await response.json()) as OpenMeteoResponse;
    } catch (err) {
      throw new ProviderError(this.name, "malformed", "JSON parse failed", err);
    }

    if (body.error || !body.hourly) {
      throw new ProviderError(
        this.name,
        "malformed",
        body.reason ?? "missing hourly data in response",
      );
    }

    const point = this.findClosestPoint(body.hourly, timestamp);
    this.healthy = true;
    return point;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  // ---------- Private helpers ----------

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

  private buildUrl(
    useArchive: boolean,
    lat: number,
    lng: number,
    timestamp: number,
  ): string {
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
    const base = useArchive ? ARCHIVE_BASE : FORECAST_BASE;
    const params = new URLSearchParams({
      latitude: lat.toString(),
      longitude: lng.toString(),
      hourly: "shortwave_radiation,direct_radiation,diffuse_radiation,cloud_cover",
      start_date: date,
      end_date: date,
      timezone: "UTC",
    });
    return `${base}?${params.toString()}`;
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    try {
      let response = await this.fetchWithTimeout(url);

      // Single retry on 5xx
      if (response.status >= 500 && response.status < 600) {
        await sleep(RETRY_DELAY_MS);
        response = await this.fetchWithTimeout(url);
      }
      return response;
    } catch (err) {
      // Connection refused / DNS / abort etc. — wrap into ProviderError
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
    hourly: OpenMeteoHourly,
    targetTs: number,
  ): IrradiancePoint {
    if (!hourly.time || hourly.time.length === 0) {
      throw new ProviderError(this.name, "malformed", "empty hourly.time array");
    }

    let closestIdx = 0;
    let closestDelta = Infinity;

    for (let i = 0; i < hourly.time.length; i++) {
      // Open-Meteo returns ISO 8601 без timezone suffix (assumed UTC due to timezone=UTC param)
      // Force Z suffix to ensure parsing as UTC, not local.
      const ts = Math.floor(new Date(hourly.time[i] + "Z").getTime() / 1000);
      const delta = Math.abs(ts - targetTs);
      if (delta < closestDelta) {
        closestDelta = delta;
        closestIdx = i;
      }
    }

    const ghi = hourly.shortwave_radiation[closestIdx];
    if (ghi === null || ghi === undefined) {
      throw new ProviderError(
        this.name,
        "malformed",
        `null GHI at index ${closestIdx} (time ${hourly.time[closestIdx]})`,
      );
    }

    const closestTime = Math.floor(
      new Date(hourly.time[closestIdx] + "Z").getTime() / 1000,
    );

    return {
      timestamp: closestTime,
      ghi,
      dni: nullableOptional(hourly.direct_radiation?.[closestIdx]),
      dhi: nullableOptional(hourly.diffuse_radiation?.[closestIdx]),
      cloudCover: nullableOptional(hourly.cloud_cover?.[closestIdx]),
      source: "open-meteo",
    };
  }
}

// ---------- Free helpers ----------

function nullableOptional(v: number | null | undefined): number | undefined {
  return v === null || v === undefined ? undefined : v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
