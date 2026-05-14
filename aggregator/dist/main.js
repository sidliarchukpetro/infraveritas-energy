import "dotenv/config";
import { buildServer } from "./api/server.js";
import { InMemoryQueue } from "./queue/index.js";
import { SubmissionWorker } from "./worker/index.js";
import { V3ChainClient } from "./chain/submit.js";
import { destroyBackends } from "./prover/honk.js";
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const V3_ADDRESS = process.env.V3_ADDRESS;
const RPC_URL = process.env.RPC_URL;
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY;
function buildChainClient() {
    if (!V3_ADDRESS || !RPC_URL || !OPERATOR_PRIVATE_KEY) {
        return null;
    }
    return new V3ChainClient({
        v3Address: V3_ADDRESS,
        rpcUrl: RPC_URL,
        operatorPrivateKey: OPERATOR_PRIVATE_KEY,
    });
}
async function main() {
    const queue = new InMemoryQueue();
    const chainClient = buildChainClient();
    const app = await buildServer({ queue });
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
    const shutdown = async (signal) => {
        app.log.info({ event: "shutdown", signal });
        try {
            await app.close();
            await destroyBackends();
        }
        catch (err) {
            app.log.error({ event: "shutdown-error", err: String(err) });
        }
        finally {
            process.exit(0);
        }
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
}
main().catch((err) => {
    console.error("aggregator failed to start:", err);
    process.exit(1);
});
