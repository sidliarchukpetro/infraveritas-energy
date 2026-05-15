/**
 * EnsembleProvider — обʼєднує множину IrradianceProvider'ів і повертає
 * консенсус-результат з divergence detection і per-provider tracing.
 *
 * Spec: docs/specs/phase4_design.md §5.
 *
 * Робота:
 *   1. Параллельний запит до всіх providers через Promise.allSettled
 *   2. Median з available points
 *   3. Standard deviation для divergence
 *   4. Status classification: ok | degraded | divergent | unavailable
 *
 * Failure handling guarantees:
 *   - Один failing provider не failить весь call (allSettled, не all)
 *   - Якщо всі провалюються — повертається status='unavailable' з ghi=0;
 *     caller сам вирішує що з цим робити (per design — submission все одно
 *     йде на chain, тільки з flag)
 *
 * Night case (median=0):
 *   - Relative divergence неможливо обчислити (ділення на 0)
 *   - Використовуємо абсолютний поріг nightStdThreshold (default 50 W/m²)
 *   - Якщо std > threshold — divergent (хтось вважає що день, хтось ніч)
 */

import {
  type IrradiancePoint,
  type IrradianceProvider,
  ProviderError,
} from "./provider.js";

// ---------- Types ----------

export type EnsembleStatus =
  | "ok"            // ≥2 providers, divergence < threshold
  | "degraded"      // тільки 1 provider responded
  | "divergent"     // ≥2 providers, divergence ≥ threshold
  | "unavailable";  // 0 providers responded

export interface ProviderResult {
  provider: string;
  point?: IrradiancePoint;
  error?: ProviderError;
}

export interface EnsembleResult {
  /** Медіана GHI з available providers, W/m². 0 якщо unavailable. */
  ghi: number;

  /** Кількість providers які успішно повернули дані (0..N). */
  providersResponded: number;

  /** Std deviation across providers. undefined якщо < 2 responded. */
  stdDev?: number;

  /** Relative divergence = stdDev / median. undefined для night case або < 2 providers. */
  relativeDivergence?: number;

  /** Per-provider raw results — для tracing у DB і debugging. */
  perProvider: ProviderResult[];

  /** Validation status (derived from above). */
  status: EnsembleStatus;
}

export interface EnsembleOptions {
  /**
   * Relative divergence threshold (stdDev/median) для marking як divergent.
   * Default 0.30 (30%). Conservative — калібрувати після ~100 real submissions.
   */
  divergenceThreshold?: number;

  /**
   * Absolute std deviation threshold для night cases (median=0).
   * Default 50 W/m². Якщо std > threshold при median=0 — divergent.
   */
  nightStdThreshold?: number;
}

const DEFAULT_DIVERGENCE_THRESHOLD = 0.30;
const DEFAULT_NIGHT_STD_THRESHOLD = 50;

// ---------- EnsembleProvider ----------

export class EnsembleProvider {
  private readonly divergenceThreshold: number;
  private readonly nightStdThreshold: number;

  constructor(
    private readonly providers: IrradianceProvider[],
    opts: EnsembleOptions = {},
  ) {
    if (providers.length === 0) {
      throw new Error("EnsembleProvider requires at least one provider");
    }
    this.divergenceThreshold = opts.divergenceThreshold ?? DEFAULT_DIVERGENCE_THRESHOLD;
    this.nightStdThreshold = opts.nightStdThreshold ?? DEFAULT_NIGHT_STD_THRESHOLD;
  }

  async fetch(lat: number, lng: number, timestamp: number): Promise<EnsembleResult> {
    // Parallel fetch — Promise.allSettled щоб failure одного не failив весь call.
    // Зберігаємо provider name разом з settled result, щоб уникнути окремого
    // index access у map (під noUncheckedIndexedAccess providers[i] = T | undefined).
    const settled = await Promise.allSettled(
      this.providers.map(async (p) => ({
        name: p.name,
        point: await p.fetch(lat, lng, timestamp),
      })),
    );

    const perProvider: ProviderResult[] = settled.map((result, i) => {
      // Provider name with safe fallback — settled.length === providers.length invariant
      const providerForIndex = this.providers[i];
      const fallbackName = providerForIndex?.name ?? "unknown";

      if (result.status === "fulfilled") {
        return { provider: result.value.name, point: result.value.point };
      }
      // Rejected — normalize до ProviderError
      const reason = result.reason;
      const error =
        reason instanceof ProviderError
          ? reason
          : new ProviderError(
              fallbackName,
              "network",
              reason instanceof Error ? reason.message : String(reason),
            );
      return { provider: fallbackName, error };
    });

    const validPoints = perProvider
      .filter((p) => p.point !== undefined)
      .map((p) => p.point as IrradiancePoint);

    return this.classify(validPoints, perProvider);
  }

  // ---------- Private ----------

  private classify(
    validPoints: IrradiancePoint[],
    perProvider: ProviderResult[],
  ): EnsembleResult {
    // Branch 1: жоден provider не responded
    if (validPoints.length === 0) {
      return {
        ghi: 0,
        providersResponded: 0,
        perProvider,
        status: "unavailable",
      };
    }

    // Branch 2: тільки один — degraded mode
    if (validPoints.length === 1) {
      const single = validPoints[0];
      // Defensive narrowing для noUncheckedIndexedAccess — length===1 guarantees existence
      if (single === undefined) {
        return { ghi: 0, providersResponded: 0, perProvider, status: "unavailable" };
      }
      return {
        ghi: single.ghi,
        providersResponded: 1,
        perProvider,
        status: "degraded",
      };
    }

    // Branch 3: ≥2 providers — compute median + std + status
    const ghis = validPoints.map((p) => p.ghi).sort((a, b) => a - b);
    const median = computeMedian(ghis);
    const stdDev = computeStdDev(ghis);

    const isNight = median === 0;
    let status: EnsembleStatus;
    let relativeDivergence: number | undefined;

    if (isNight) {
      // Night case — use absolute threshold, relative undefined
      status = stdDev >= this.nightStdThreshold ? "divergent" : "ok";
    } else {
      relativeDivergence = stdDev / median;
      status = relativeDivergence >= this.divergenceThreshold ? "divergent" : "ok";
    }

    return {
      ghi: median,
      providersResponded: validPoints.length,
      stdDev,
      relativeDivergence,
      perProvider,
      status,
    };
  }
}

// ---------- Free helpers ----------

function computeMedian(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n % 2 === 1) {
    const mid = sortedAsc[(n - 1) / 2];
    return mid ?? 0;
  }
  const lo = sortedAsc[n / 2 - 1];
  const hi = sortedAsc[n / 2];
  return ((lo ?? 0) + (hi ?? 0)) / 2;
}

function computeStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, x) => s + x, 0) / values.length;
  const variance = values.reduce((s, x) => s + (x - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
