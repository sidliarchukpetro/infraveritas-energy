/**
 * API integration tests — full HTTP layer + worker pipeline.
 *
 * Covers:
 *   - GET /health returns queue stats
 *   - POST /submissions validation (400 on malformed)
 *   - POST /submissions happy path (202 + sessionKey)
 *   - POST /submissions duplicate detection (409)
 *   - End-to-end pipeline: submission → witness → proof → local verify
 *     (mock chain mode, no real V3 deployment needed)
 *
 * Worker runs in mock mode (no chainClient). When Sepolia V3 deploys
 * and a chain-live test variant is needed, parameterize this suite with
 * a real V3ChainClient instance.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import type { FastifyInstance } from "fastify";
import {
  type CanonicalPayload,
  type Reading,
  READINGS_PER_PAYLOAD,
  computePayloadHash,
} from "../../src/verify/canonical.js";
import { destroyBackends } from "../../src/prover/honk.js";
import { InMemoryQueue } from "../../src/queue/index.js";
import { SubmissionWorker } from "../../src/worker/index.js";
import { buildServer, type SubmissionJob } from "../../src/api/server.js";

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function makeFreshPayload(sessionId: bigint): CanonicalPayload {
  const readings: Reading[] = [];
  for (let i = 0; i < READINGS_PER_PAYLOAD; i++) {
    readings.push({
      voltage_mv: BigInt(5500 + i),
      current_ma: BigInt(240 + i),
      timestamp_ms: BigInt(1000 + i * 100),
    });
  }
  return {
    device_id: 42n,
    session_id: sessionId,
    epoch_start_ts: 1_778_000_000n,
    lat_e7: 484_517_000n,
    lon_e7: 255_752_000n,
    light_level: 5000n,
    tamper_flag: 0n,
    readings,
  };
}

async function buildRequestBody(
  payload: CanonicalPayload,
  sk: Uint8Array,
  pk: Uint8Array,
) {
  const hash = await computePayloadHash(payload);
  const sig = p256.sign(hash, sk, { lowS: true, prehash: false });
  return {
    payload: {
      device_id: payload.device_id.toString(),
      session_id: payload.session_id.toString(),
      epoch_start_ts: payload.epoch_start_ts.toString(),
      lat_e7: payload.lat_e7.toString(),
      lon_e7: payload.lon_e7.toString(),
      light_level: payload.light_level.toString(),
      tamper_flag: payload.tamper_flag.toString(),
      readings: payload.readings.map((r) => ({
        voltage_mv: r.voltage_mv.toString(),
        current_ma: r.current_ma.toString(),
        timestamp_ms: r.timestamp_ms.toString(),
      })),
    },
    signature: bytesToHex(sig),
    public_key: bytesToHex(pk.slice(1)), // drop 0x04 prefix
  };
}

describe("API + worker integration", { timeout: 180_000 }, () => {
  let app: FastifyInstance;
  let queue: InMemoryQueue<SubmissionJob>;
  // Shared keypair across tests — saves time vs re-generating
  let sk: Uint8Array;
  let pk: Uint8Array;

  beforeAll(async () => {
    queue = new InMemoryQueue<SubmissionJob>();
    app = buildServer({ queue, logger: false });
    // Mock-mode worker: no chainClient, but still runs witness + proof + verify.
    void new SubmissionWorker(queue, null);
    await app.ready();
    sk = p256.utils.randomSecretKey();
    pk = p256.getPublicKey(sk, false);
  });

  afterAll(async () => {
    await app.close();
    await destroyBackends();
  });

  it("GET /health returns ok with queue stats", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.queue).toMatchObject({
      total: expect.any(Number),
      pending: expect.any(Number),
      processing: expect.any(Number),
    });
  });

  it("POST /submissions rejects malformed body with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/submissions",
      payload: { foo: "bar" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("ValidationFailed");
  });

  it("POST /submissions accepts valid payload and returns 202", async () => {
    const payload = makeFreshPayload(1n);
    const body = await buildRequestBody(payload, sk, pk);
    const res = await app.inject({
      method: "POST",
      url: "/submissions",
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    const json = res.json();
    expect(json.sessionKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(json.status).toBe("pending");
  });

  it("POST /submissions duplicate sessionKey returns 409", async () => {
    const payload = makeFreshPayload(2n);
    const body = await buildRequestBody(payload, sk, pk);

    const first = await app.inject({
      method: "POST",
      url: "/submissions",
      payload: body,
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: "POST",
      url: "/submissions",
      payload: body,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("DuplicateSessionKey");
  });

  it("end-to-end: HTTP submission processes through worker to complete", async () => {
    const payload = makeFreshPayload(3n);
    const body = await buildRequestBody(payload, sk, pk);

    const res = await app.inject({
      method: "POST",
      url: "/submissions",
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    const { sessionKey } = res.json();

    // Poll for completion (worker is async)
    let lastStatus = "";
    let finished = false;
    for (let i = 0; i < 240; i++) {
      const status = await app.inject({
        method: "GET",
        url: `/submissions/${sessionKey}`,
      });
      const json = status.json();
      lastStatus = json.status;
      if (
        json.status === "complete" ||
        json.status === "failed" ||
        json.status === "quarantined"
      ) {
        finished = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(finished).toBe(true);
    expect(lastStatus).toBe("complete");
  });
});
