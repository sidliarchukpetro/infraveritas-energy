/**
 * Fastify HTTP API for the aggregator.
 *
 * Spec: docs/specs/aggregator_design.md §3.1.
 *
 * Endpoints:
 *   POST /submissions          — accept signed payload, validate, enqueue
 *   GET  /submissions/:id      — poll status (id = sessionKey hex)
 *   GET  /health               — liveness probe (returns queue stats)
 *
 * JSON wire format:
 *   - All uint64/int64 fields encoded as decimal strings (JS Number unsafe
 *     past 2^53; uint64 max is 2^64-1). Parser converts to bigint.
 *   - signature, public_key — lowercase hex, exactly 128 chars (64 bytes).
 *   - readings — exactly 100 items.
 *
 * The handler does CHEAP validation only (shape, lengths, basic ranges).
 * Heavy work (Poseidon hash, P-256 verify, ZK proof) deferred to worker.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { keccak256, toBytes } from "viem";
import type { CanonicalPayload, Reading } from "../verify/canonical.js";
import { InMemoryQueue, type JobRecord } from "../queue/index.js";

// ---------- Schemas ----------

const u64String = z.string().regex(/^\d+$/, "expected decimal uint64");
const i64String = z.string().regex(/^-?\d+$/, "expected decimal int64");
const hex128 = z.string().regex(/^[0-9a-f]{128}$/, "expected 128 lowercase hex chars");

const readingSchema = z.object({
  voltage_mv: u64String,
  current_ma: u64String,
  timestamp_ms: u64String,
});

const payloadSchema = z.object({
  device_id: u64String,
  session_id: u64String,
  epoch_start_ts: u64String,
  lat_e7: i64String,
  lon_e7: i64String,
  light_level: u64String,
  tamper_flag: u64String,
  readings: z.array(readingSchema).length(100),
});

const submissionSchema = z.object({
  payload: payloadSchema,
  signature: hex128,
  public_key: hex128,
});

export type SubmissionRequest = z.infer<typeof submissionSchema>;

// ---------- Queue job payload ----------

export interface SubmissionJob {
  sessionKey: string; // keccak256(deviceId || sessionId) — used as job id
  payload: CanonicalPayload;
  signature: Uint8Array;
  pubkey: Uint8Array;
  receivedAt: Date;
}

// ---------- Helpers ----------

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

function parsePayload(req: SubmissionRequest): CanonicalPayload {
  const readings: Reading[] = req.payload.readings.map((r) => ({
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

/** keccak256(uint64 deviceId || uint64 sessionId), matches V3 sessionKey. */
function computeSessionKey(deviceId: bigint, sessionId: bigint): string {
  const buf = new Uint8Array(16);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(0, deviceId, false);
  dv.setBigUint64(8, sessionId, false);
  return keccak256(buf);
}

// ---------- Serialization helpers (bigint-safe JSON) ----------

function serializeJob(job: JobRecord<SubmissionJob>) {
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

// ---------- Server builder ----------

export interface BuildServerOptions {
  queue: InMemoryQueue<SubmissionJob>;
  logger?: boolean | object;
}

export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? { level: "info" },
    bodyLimit: 256 * 1024, // 256 KB — accommodates 2456-byte payload + sig + pubkey + JSON overhead
  });

  app.get("/health", async () => {
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

    // Deduplication — same sessionKey can't be enqueued twice
    if (opts.queue.get(sessionKey)) {
      return reply.code(409).send({
        error: "DuplicateSessionKey",
        sessionKey,
      });
    }

    const job: SubmissionJob = {
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

  app.get<{ Params: { id: string } }>("/submissions/:id", async (request, reply) => {
    const record = opts.queue.get(request.params.id);
    if (!record) {
      return reply.code(404).send({ error: "NotFound" });
    }
    return serializeJob(record);
  });

  return app;
}
