import "dotenv/config";
/**
 * Aggregator entry point.
 *
 * Wires queue, worker, и Fastify server разом з environment vars. Phase 4
 * додає optional validation pipeline (cross-validation + statistics + anomaly +
 * persistence) — підключається коли DATABASE_URL env задана.
 *
 * Required env (production / chain-live mode):
 *   V3_ADDRESS              0x-prefixed EnergyProofRegistryV3 proxy address
 *   RPC_URL                 Sepolia / mainnet RPC endpoint
 *   OPERATOR_PRIVATE_KEY    0x-prefixed P-256 private key with OPERATOR_ROLE
 *
 * Phase 4 env (optional):
 *   DATABASE_URL            postgres://user:pass@host:port/db
 *                           Якщо задана — wire ValidationPipeline з real pg.Pool.
 *                           Якщо ні — worker працює без validation, як раніше.
 *
 * Optional env:
 *   PORT                    HTTP server port (default 3000)
 *   HOST                    HTTP bind address (default 0.0.0.0)
 *
 * Чотири режими комбінації chain × validation:
 *   chain=live  + validation=enabled  → full production
 *   chain=live  + validation=disabled → submit без observability (degraded)
 *   chain=mock  + validation=enabled  → dev з real DB testing
 *   chain=mock  + validation=disabled → minimal proof-only dev
 */

import type { Address, Hex } from "viem";
import { Pool, type PoolConfig } from "pg";
import { buildServer, type SubmissionJob } from "./api/server.js";
import { InMemoryQueue } from "./queue/index.js";
import { SubmissionWorker } from "./worker/index.js";
import { V3ChainClient } from "./chain/submit.js";
import { destroyBackends } from "./prover/honk.js";
import { EnsembleProvider } from "./validation/weather/ensemble.js";
import { OpenMeteoProvider } from "./validation/weather/openMeteo.js";
import { NASAPowerProvider } from "./validation/weather/nasaPower.js";
import { PVGISProvider } from "./validation/weather/pvgis.js";
import { StatisticsModule } from "./validation/statistics.js";
import { SubmissionPersistence } from "./validation/persistence.js";
import { ValidationPipeline } from "./validation/pipeline.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const V3_ADDRESS = process.env.V3_ADDRESS;
const RPC_URL = process.env.RPC_URL;
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

// Individual Postgres env vars — preferred over DATABASE_URL because
// the password is passed as a raw string and never URL-parsed, so it
// tolerates any special characters (/, +, @, :, etc.) without encoding.
// See docs/notes/phase4_implementation_notes.md §8.2.
const POSTGRES_USER = process.env.POSTGRES_USER;
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD;
const POSTGRES_HOST = process.env.POSTGRES_HOST;
const POSTGRES_PORT = process.env.POSTGRES_PORT;
const POSTGRES_DB = process.env.POSTGRES_DB;

function buildChainClient(): V3ChainClient | null {
  if (!V3_ADDRESS || !RPC_URL || !OPERATOR_PRIVATE_KEY) {
    return null;
  }
  return new V3ChainClient({
    v3Address: V3_ADDRESS as Address,
    rpcUrl: RPC_URL,
    operatorPrivateKey: OPERATOR_PRIVATE_KEY as Hex,
  });
}

interface ValidationSetup {
  pipeline: ValidationPipeline;
  pool: Pool;
}

/**
 * Wire Phase 4 validation pipeline якщо DATABASE_URL присутня.
 *
 * Returns:
 *   - { pipeline, pool } коли DATABASE_URL задана; pool тримається для cleanup
 *     у shutdown handler
 *   - null коли DATABASE_URL пуста — worker працює без validation
 */
/**
 * Build pg PoolConfig from env vars.
 *
 * Preferred path: individual POSTGRES_USER/POSTGRES_PASSWORD (+ optional
 * POSTGRES_HOST/PORT/DB) — password is passed as a raw string to pg,
 * never URL-parsed, so it tolerates `/`, `+`, `@`, `:` etc. without
 * any encoding. This is robust to whatever the password generator emits.
 *
 * Fallback: DATABASE_URL connection string — kept for backward compat
 * with existing setups. Password in URL must be URL-encoded if it
 * contains special chars (`/` is the common offender).
 *
 * Returns null when no DB is configured — caller treats it as
 * "validation disabled".
 */
function buildPoolConfig(): PoolConfig | null {
  if (POSTGRES_USER && POSTGRES_PASSWORD) {
    return {
      host: POSTGRES_HOST ?? "127.0.0.1",
      port: POSTGRES_PORT ? Number.parseInt(POSTGRES_PORT, 10) : 5432,
      user: POSTGRES_USER,
      password: POSTGRES_PASSWORD,
      database: POSTGRES_DB ?? "infraveritas_energy",
    };
  }
  if (DATABASE_URL) {
    return { connectionString: DATABASE_URL };
  }
  return null;
}

function buildValidationPipeline(): ValidationSetup | null {
  const poolConfig = buildPoolConfig();
  if (!poolConfig) {
    return null;
  }

  const pool = new Pool(poolConfig);

  // Three weather providers — Promise.allSettled у ensemble, тому
  // network failure одного не блокує інших.
  const ensemble = new EnsembleProvider([
    new OpenMeteoProvider(),
    new NASAPowerProvider(),
    new PVGISProvider(),
  ]);

  const statistics = new StatisticsModule(pool);
  const persistence = new SubmissionPersistence(pool);

  return {
    pipeline: new ValidationPipeline(ensemble, statistics, persistence),
    pool,
  };
}

async function main(): Promise<void> {
  const queue = new InMemoryQueue<SubmissionJob>();
  const chainClient = buildChainClient();
  const validationSetup = buildValidationPipeline();
  const app = await buildServer({ queue });

  // Worker self-registers як listener на queue.
  // The `void` discards the unused-binding warning while keeping the side effect.
  void new SubmissionWorker(
    queue,
    chainClient,
    {
      info: (msg) => app.log.info(msg),
      warn: (msg) => app.log.warn(msg),
      error: (msg) => app.log.error(msg),
    },
    validationSetup?.pipeline,
  );

  const address = await app.listen({ port: PORT, host: HOST });
  app.log.info({
    event: "aggregator-started",
    address,
    chain: chainClient ? "live" : "mock",
    v3Address: V3_ADDRESS ?? null,
    operator: chainClient?.operatorAddress ?? null,
    validation: validationSetup ? "enabled" : "disabled",
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ event: "shutdown", signal });
    try {
      await app.close();
      await destroyBackends();
      if (validationSetup) {
        await validationSetup.pool.end();
      }
    } catch (err) {
      app.log.error({ event: "shutdown-error", err: String(err) });
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("aggregator failed to start:", err);
  process.exit(1);
});
