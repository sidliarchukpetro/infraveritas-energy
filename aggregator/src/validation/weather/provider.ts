/**
 * Weather irradiance provider interface — single source of truth для трьох
 * concrete providers у ensemble (Open-Meteo, NASA POWER, PVGIS).
 *
 * Spec: docs/specs/phase4_design.md §3.
 *
 * Design choices:
 *   - Один метод fetch() для current і historical — concrete provider знає
 *     сам куди йти (forecast vs archive endpoint).
 *   - Повертає один найближчий до timestamp point, не масив. Спрощує
 *     EnsembleProvider logic (3 значення → median тривіальна).
 *   - GHI обов'язковий, DNI/DHI/cloudCover optional — не всі providers
 *     дають однаковий набір; primary metric для validation — GHI.
 *   - ProviderError з кодом — щоб EnsembleProvider міг диференціювати
 *     тимчасові проблеми (rate-limit, network) від permanent (malformed).
 */

export interface IrradiancePoint {
  /** Unix timestamp у секундах, найближчий до запитуваного. */
  timestamp: number;

  /** Global Horizontal Irradiance, W/m². Може бути 0 (ніч). */
  ghi: number;

  /** Direct Normal Irradiance, W/m². Optional — не всі providers дають. */
  dni?: number;

  /** Diffuse Horizontal Irradiance, W/m². Optional. */
  dhi?: number;

  /** Cloud cover, 0–100%. Optional. */
  cloudCover?: number;

  /** Provider name для tracing. */
  source: "open-meteo" | "nasa-power" | "pvgis";
}

export interface IrradianceProvider {
  readonly name: string;

  /**
   * Fetch irradiance for given location at specific timestamp.
   * Concrete provider routes internally до forecast vs archive endpoint
   * based on timestamp recency.
   *
   * @param lat — широта у decimal degrees, range [-90, 90]
   * @param lng — довгота у decimal degrees, range [-180, 180]
   * @param timestamp — Unix timestamp у секундах
   * @throws ProviderError на network/parse/rate-limit/validation failure
   * @returns Single IrradiancePoint nearest to requested timestamp
   */
  fetch(lat: number, lng: number, timestamp: number): Promise<IrradiancePoint>;

  /**
   * Health check — швидкий readiness probe без real API call.
   * Reflects last-known-good state.
   */
  isHealthy(): boolean;
}

export type ProviderErrorCode = "network" | "rate-limit" | "malformed" | "not-found";

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`${provider}: ${code}: ${message}`);
    this.name = "ProviderError";
  }
}

/**
 * HTTP fetcher type — щоб providers могли приймати mock у тестах
 * без monkey-patching global fetch.
 */
export type HttpFetcher = (url: string, init?: RequestInit) => Promise<Response>;
