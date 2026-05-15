/**
 * PVGISProvider — PVGIS (Joint Research Centre, European Commission)
 * hourly solar radiation time series.
 *
 * Spec: docs/specs/phase4_design.md §4.3.
 *
 * Endpoint: https://re.jrc.ec.europa.eu/api/v5_2/seriescalc
 *
 * Returns hourly time series для всього року. Базується на SARAH-2
 * satellite data (Meteosat) для Європи — найточніше покриття України.
 * За межами Європи — CMSAF/ERA5 fallback (нижча якість).
 *
 * No API key required. Rate limit не задокументований явно;
 * у практиці ~1 req/s без проблем (JRC рекомендує "reasonable use").
 *
 * PVGIS специфічно для PV — повертає:
 *   - G(i)  : Global irradiance на inclined plane (default = horizontal), W/m²
 *   - Gb(n) : Direct beam normal (DNI), W/m²
 *   - Gd(h) : Diffuse horizontal (DHI), W/m²
 *
 * Time format у response: "YYYYMMDD:HHMM" (e.g. "20260515:1200")
 */

import {
  type HttpFetcher,
  type IrradiancePoint,
  type IrradianceProvider,
  ProviderError,
} from "./provider.js";

const ENDPOINT = "https://re.jrc.ec.europa.eu/api/v5_2/seriescalc";

const DEFAULT_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 500;
const USER_AGENT = "infraveritas-aggregator/0.1 (+https://infraveritas.pro)";

interface PVGISHourlyEntry {
  time: string; // "YYYYMMDD:HHMM"
  "G(i)": number | null;
  "Gb(n)"?: number | null;
  "Gd(h)"?: number | null;
  H_sun?: number;
  T2m?: number;
  WS10m?: number;
}

interface PVGISResponse {
  outputs?: {
    hourly?: PVGISHourlyEntry[];
  };
  message?: string;
  status?: string;
}

export interface PVGISOptions {
  fetcher?: HttpFetcher;
  timeoutMs?: number;
}

export class PVGISProvider implements IrradianceProvider {
  public readonly name = "pvgis";

  private readonly fetcher: HttpFetcher;
  private readonly timeoutMs: number;
  private healthy = true;

  constructor(opts: PVGISOptions = {}) {
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

    let body: PVGISResponse;
    try {
      body = (await response.json()) as PVGISResponse;
    } catch (err) {
      throw new ProviderError(this.name, "malformed", "JSON parse failed", err);
    }

    const hourly = body.outputs?.hourly;
    if (!hourly || hourly.length === 0) {
      throw new ProviderError(
        this.name,
        "malformed",
        body.message ?? "missing outputs.hourly array",
      );
    }

    const point = this.findClosestPoint(hourly, timestamp);
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
    const year = new Date(timestamp * 1000).getUTCFullYear();
    const params = new URLSearchParams({
      lat: lat.toString(),
      lon: lng.toString(),
      startyear: year.toString(),
      endyear: year.toString(),
      outputformat: "json",
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
    hourly: PVGISHourlyEntry[],
    targetTs: number,
  ): IrradiancePoint {
    let closestEntry: PVGISHourlyEntry | null = null;
    let closestDelta = Infinity;
    let closestTs = 0;

    for (const entry of hourly) {
      const ts = parsePVGISTime(entry.time);
      if (ts === null) continue;
      const delta = Math.abs(ts - targetTs);
      if (delta < closestDelta) {
        closestDelta = delta;
        closestEntry = entry;
        closestTs = ts;
      }
    }

    if (closestEntry === null) {
      throw new ProviderError(
        this.name,
        "malformed",
        "no parseable time entries у hourly array (expected YYYYMMDD:HHMM format)",
      );
    }

    const ghi = closestEntry["G(i)"];
    if (ghi === null || ghi === undefined || !Number.isFinite(ghi)) {
      throw new ProviderError(
        this.name,
        "malformed",
        `invalid G(i) at ${closestEntry.time}: ${ghi}`,
      );
    }

    return {
      timestamp: closestTs,
      ghi,
      dni: validNumber(closestEntry["Gb(n)"]),
      dhi: validNumber(closestEntry["Gd(h)"]),
      source: "pvgis",
    };
  }
}

// ---------- Free helpers ----------

function parsePVGISTime(time: string): number | null {
  // Format: "YYYYMMDD:HHMM", e.g. "20260515:1200"
  const match = /^(\d{4})(\d{2})(\d{2}):(\d{2})(\d{2})$/.exec(time);
  if (!match) return null;
  const [, yyyy, mm, dd, hh, mn] = match;
  // Under noUncheckedIndexedAccess match groups are typed string | undefined,
  // even though successful regex match guarantees they're strings. Narrow explicitly.
  if (
    yyyy === undefined ||
    mm === undefined ||
    dd === undefined ||
    hh === undefined ||
    mn === undefined
  ) {
    return null;
  }
  return Math.floor(
    Date.UTC(
      parseInt(yyyy, 10),
      parseInt(mm, 10) - 1,
      parseInt(dd, 10),
      parseInt(hh, 10),
      parseInt(mn, 10),
    ) / 1000,
  );
}

function validNumber(v: number | null | undefined): number | undefined {
  if (v === null || v === undefined || !Number.isFinite(v)) return undefined;
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
