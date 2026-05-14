/**
 * End-to-end prover integration test.
 *
 * Verifies the full aggregator pipeline:
 *   1. Compute payload hash (matches edge Python — covered separately in crosslang)
 *   2. Sign hash with P-256 + low-s normalization (mimics edge ATECC608B behaviour)
 *   3. Generate Noir witness — runs all 4 v08 circuit checks internally
 *      (Poseidon sponge, metadata destructuring, P-256 ECDSA verify, energy sum)
 *   4. Generate UltraHonk proof with verifierTarget='evm'
 *   5. Verify proof locally (same bb.js backend that V3 contract uses on-chain)
 *   6. Assert publicInputs[0..8] match V3.PublicInputs order
 *
 * Timing baselines logged for tracking regression in prover performance.
 *
 * If this test fails after prover changes — full pipeline is broken; debug
 * starting from witness generation (most expressive errors there).
 */

import { describe, it, expect } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import {
  type CanonicalPayload,
  type Reading,
  READINGS_PER_PAYLOAD,
  computePayloadHash,
} from "../../src/verify/canonical.js";
import {
  generateWitness,
  computeTotalEnergy,
} from "../../src/prover/witness.js";
import {
  generateProof,
  verifyProofLocally,
  destroyBackends,
} from "../../src/prover/honk.js";

function makeTestPayload(): CanonicalPayload {
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
    session_id: 1n,
    epoch_start_ts: 1_778_000_000n,
    lat_e7: 484_517_000n,
    lon_e7: 255_752_000n,
    light_level: 5000n,
    tamper_flag: 0n,
    readings,
  };
}

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

describe(
  "Phase 4.2 prover end-to-end (sign → witness → proof → verify)",
  { timeout: 180_000 },
  () => {
    it("produces a valid Honk proof for a signed canonical payload", async () => {
      // ----- 1. Keypair (mimics edge ATECC608B slot 0 P-256 key) -----
      const secretKey = p256.utils.randomSecretKey(); // 32 bytes
      const publicKey = p256.getPublicKey(secretKey, false); // 65 bytes: 0x04 || X || Y
      expect(publicKey.length).toBe(65);
      expect(publicKey[0]).toBe(0x04);
      const pubkeyXY = publicKey.slice(1); // 64 bytes for witness

      // ----- 2. Build deterministic payload (same shape as edge fixture) -----
      const payload = makeTestPayload();

      // ----- 3. Compute payload hash + sign with low-s normalization -----
      const hash = await computePayloadHash(payload);
      expect(hash.length).toBe(32);

      const signature = p256.sign(hash, secretKey, { lowS: true, prehash: false });
      expect(signature.length).toBe(64); // raw r || s

      // Local P-256 sanity (catches signing API regressions before bb.js)
      const localSigOk = p256.verify(signature, hash, publicKey, { prehash: false });
      expect(localSigOk).toBe(true);

      // ----- 4. Generate Noir witness (runs 4 circuit checks inside) -----
      const tWitness = Date.now();
      const { witness } = await generateWitness({
        payload,
        signature,
        pubkey: pubkeyXY,
      });
      const witnessMs = Date.now() - tWitness;
      console.log(`witness: ${witness.length} bytes in ${witnessMs}ms`);
      expect(witness.length).toBeGreaterThan(0);

      // ----- 5. Generate UltraHonk proof (EVM target for HonkVerifier.sol) -----
      const tProof = Date.now();
      const proof = await generateProof(witness);
      const proofMs = Date.now() - tProof;
      console.log(`proof: ${proof.proof.length} bytes in ${proofMs}ms`);
      expect(proof.publicInputs.length).toBe(9);

      // ----- 6. Verify locally -----
      const tVerify = Date.now();
      const verified = await verifyProofLocally(proof);
      const verifyMs = Date.now() - tVerify;
      console.log(`verify: ${verified} in ${verifyMs}ms`);
      expect(verified).toBe(true);

      // ----- 7. Validate publicInputs in V3.PublicInputs order -----
      // [0] device_id, [1] session_id, [2] epoch_start_ts,
      // [3] lat_e7, [4] lon_e7, [5] light_level, [6] tamper_flag,
      // [7] payload_hash, [8] total_energy_mwh
      expect(BigInt(proof.publicInputs[0]!)).toBe(payload.device_id);
      expect(BigInt(proof.publicInputs[1]!)).toBe(payload.session_id);
      expect(BigInt(proof.publicInputs[2]!)).toBe(payload.epoch_start_ts);
      expect(BigInt(proof.publicInputs[3]!)).toBe(payload.lat_e7);
      expect(BigInt(proof.publicInputs[4]!)).toBe(payload.lon_e7);
      expect(BigInt(proof.publicInputs[5]!)).toBe(payload.light_level);
      expect(BigInt(proof.publicInputs[6]!)).toBe(payload.tamper_flag);
      expect(BigInt(proof.publicInputs[7]!)).toBe(bytesToBigIntBE(hash));
      expect(BigInt(proof.publicInputs[8]!)).toBe(computeTotalEnergy(payload));

      await destroyBackends();
    });
  },
);
