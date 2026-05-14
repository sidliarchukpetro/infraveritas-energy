import "dotenv/config";
/**
 * Aggregator entry point.
 *
 * Wires queue, worker, and Fastify server together from environment vars.
 *
 * Required env (production / chain-live mode):
 *   V3_ADDRESS              0x-prefixed EnergyProofRegistryV3 proxy address
 *   RPC_URL                 Sepolia / mainnet RPC endpoint
 *   OPERATOR_PRIVATE_KEY    0x-prefixed P-256 private key with OPERATOR_ROLE
 *
 * Optional env:
 *   PORT                    HTTP server port (default 3000)
 *   HOST                    HTTP bind address (default 0.0.0.0)
 *
 * If any chain env is missing — worker runs in MOCK mode: still does
 * witness + proof + local verify, but does NOT submit on-chain. Useful
 * for dev before Sepolia deployment lands. Flip to live by setting the
 * three chain env vars; no code change required.
 */

import type { Address, Hex } from "viem";
import { buildServer, type SubmissionJob } from "./api/server.js";
import { InMemoryQueue } from "./queue/index.js";
import { SubmissionWorker } from "./worker/index.js";
import { V3ChainClient } from "./chain/submit.js";
import { destroyBackends } from "./prover/honk.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const V3_ADDRESS = process.env.V3_ADDRESS;
const RPC_URL = process.env.RPC_URL;
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY;

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

async function main(): Promise<void> {
  const queue = new InMemoryQueue<SubmissionJob>();
  const chainClient = buildChainClient();
  const app = await buildServer({ queue });

  // Worker self-registers as listener on queue.
  // The `void` discards the unused-binding warning while keeping the side effect.
  void new SubmissionWorker(queue, chainClient, {
    info: (msg) => app.log.info(msg),
    warn: (msg) => app.log.warn(msg),
    error: (msg) => app.log.error(msg),
  });

  const address = await app.listen({ port: PORT, host: HOST });
  app.log.info({
    event: "aggregator-started",
    address,
    chain: chainClient ? "live" : "mock",
    v3Address: V3_ADDRESS ?? null,
    operator: chainClient?.operatorAddress ?? null,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ event: "shutdown", signal });
    try {
      await app.close();
      await destroyBackends();
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
