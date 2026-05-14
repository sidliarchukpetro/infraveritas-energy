import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { keccak256 } from "viem";
const U64_MAX = 0xffffffffffffffffn;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const LAT_MAX_E7 = 900000000n;
const LON_MAX_E7 = 1800000000n;
const u64String = z
    .string()
    .regex(/^\d+$/, "expected decimal uint64")
    .refine((s) => {
    try {
        return BigInt(s) <= U64_MAX;
    }
    catch {
        return false;
    }
}, "value exceeds uint64 range (2^64-1)");
const i64String = z
    .string()
    .regex(/^-?\d+$/, "expected decimal int64")
    .refine((s) => {
    try {
        const n = BigInt(s);
        return n >= I64_MIN && n <= I64_MAX;
    }
    catch {
        return false;
    }
}, "value exceeds int64 range");
const latE7Schema = i64String.refine((s) => {
    const n = BigInt(s);
    return n >= -LAT_MAX_E7 && n <= LAT_MAX_E7;
}, "lat_e7 must be in [-90°, +90°] (scaled by 1e7)");
const lonE7Schema = i64String.refine((s) => {
    const n = BigInt(s);
    return n >= -LON_MAX_E7 && n <= LON_MAX_E7;
}, "lon_e7 must be in [-180°, +180°] (scaled by 1e7)");
const tamperFlagSchema = u64String.refine((s) => s === "0" || s === "1", "tamper_flag must be 0 or 1");
const hex128 = z
    .string()
    .regex(/^[0-9a-f]{128}$/, "expected 128 lowercase hex chars");
const readingSchema = z.object({
    voltage_mv: u64String,
    current_ma: u64String,
    timestamp_ms: u64String,
});
const payloadSchema = z.object({
    device_id: u64String,
    session_id: u64String,
    epoch_start_ts: u64String,
    lat_e7: latE7Schema,
    lon_e7: lonE7Schema,
    light_level: u64String,
    tamper_flag: tamperFlagSchema,
    readings: z.array(readingSchema).length(100),
});
const submissionSchema = z.object({
    payload: payloadSchema,
    signature: hex128,
    public_key: hex128,
});
function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return out;
}
function parsePayload(req) {
    const readings = req.payload.readings.map((r) => ({
        voltage_mv: BigInt(r.voltage_mv),
        current_ma: BigInt(r.current_ma),
        timestamp_ms: BigInt(r.timestamp_ms),
    }));
    return {
        device_id: BigInt(req.payload.device_id),
        session_id: BigInt(req.payload.session_id),
        epoch_start_ts: BigInt(req.payload.epoch_start_ts),
        lat_e7: BigInt(req.payload.lat_e7),
        lon_e7: BigInt(req.payload.lon_e7),
        light_level: BigInt(req.payload.light_level),
        tamper_flag: BigInt(req.payload.tamper_flag),
        readings,
    };
}
function computeSessionKey(deviceId, sessionId) {
    const buf = new Uint8Array(16);
    const dv = new DataView(buf.buffer);
    dv.setBigUint64(0, deviceId, false);
    dv.setBigUint64(8, sessionId, false);
    return keccak256(buf);
}
function serializeJob(job) {
    return {
        id: job.id,
        status: job.status,
        attempts: job.attempts,
        enqueuedAt: job.enqueuedAt.toISOString(),
        startedAt: job.startedAt?.toISOString(),
        finishedAt: job.finishedAt?.toISOString(),
        error: job.error,
    };
}
export async function buildServer(opts) {
    const app = Fastify({
        logger: opts.logger ?? { level: "info" },
        bodyLimit: 256 * 1024,
    });
    if (opts.rateLimit !== false) {
        const config = opts.rateLimit ?? {};
        await app.register(rateLimit, {
            max: config.max ?? 10,
            timeWindow: config.timeWindow ?? "1 minute",
        });
    }
    app.get("/health", {
        config: { rateLimit: false },
    }, async () => {
        return {
            status: "ok",
            queue: opts.queue.size(),
            uptime_s: Math.floor(process.uptime()),
        };
    });
    app.post("/submissions", async (request, reply) => {
        const parsed = submissionSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "ValidationFailed",
                issues: parsed.error.issues,
            });
        }
        const payload = parsePayload(parsed.data);
        const sessionKey = computeSessionKey(payload.device_id, payload.session_id);
        if (opts.queue.get(sessionKey)) {
            return reply.code(409).send({
                error: "DuplicateSessionKey",
                sessionKey,
            });
        }
        const job = {
            sessionKey,
            payload,
            signature: hexToBytes(parsed.data.signature),
            pubkey: hexToBytes(parsed.data.public_key),
            receivedAt: new Date(),
        };
        opts.queue.enqueue(sessionKey, job);
        return reply.code(202).send({
            sessionKey,
            status: "pending",
            poll: `/submissions/${sessionKey}`,
        });
    });
    app.get("/submissions/:id", async (request, reply) => {
        const record = opts.queue.get(request.params.id);
        if (!record) {
            return reply.code(404).send({ error: "NotFound" });
        }
        return serializeJob(record);
    });
    return app;
}
