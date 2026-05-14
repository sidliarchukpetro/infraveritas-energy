/**
 * Cross-language canonical encoding tests.
 *
 * Verifies aggregator TS canonical.ts matches edge/hal/canonical.py bit-exact.
 *
 * Fixture: _make_test_payload from edge/tests/test_mock_edge_device.py.
 * Golden values captured from edge/.venv/bin/python — see comments inline.
 *
 * If any test here fails, edge Python ↔ aggregator TS hash chain is broken
 * and V3 submitProof will revert at the payload_hash consistency check.
 */

import { describe, it, expect } from "vitest";
import {
  canonicalize,
  computePayloadHash,
  bytesToFieldElements,
  EXPECTED_PAYLOAD_BYTES,
  EXPECTED_FIELD_ELEMENTS,
  READINGS_PER_PAYLOAD,
  type CanonicalPayload,
  type Reading,
} from "../../src/verify/canonical.js";

/**
 * TS replica of edge _make_test_payload():
 *   readings[i] = Reading(voltage_mv=5500+i, current_ma=240+i, timestamp_ms=1000+i*100)
 *   device_id=42, session_id=1, epoch_start_ts=1_778_000_000
 *   lat_e7=484517000, lon_e7=255752000, light_level=5000, tamper_flag=0
 */
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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("canonical encoding cross-language parity (TS ↔ Python edge)", () => {
  describe("canonicalize — pre-image bytes match edge Python", () => {
    it("total length is 2456 bytes (56 metadata + 100×24 readings)", () => {
      const bytes = canonicalize(makeTestPayload());
      expect(bytes.length).toBe(EXPECTED_PAYLOAD_BYTES);
      expect(bytes.length).toBe(2456);
    });

    it("metadata block (first 56 bytes) matches Python encoding", () => {
      const bytes = canonicalize(makeTestPayload());
      // From Python: canonicalize(_make_test_payload())[:56].hex()
      const expected =
        "000000000000002a" + // device_id = 42
        "0000000000000001" + // session_id = 1
        "0000000069fa2080" + // epoch_start_ts = 1_778_000_000
        "000000001ce12488" + // lat_e7 = 484_517_000
        "000000000f3e7740" + // lon_e7 = 255_752_000
        "0000000000001388" + // light_level = 5000
        "0000000000000000"; // tamper_flag = 0
      expect(toHex(bytes.slice(0, 56))).toBe(expected);
    });

    it("reading[0] encodes as 24 BE bytes (voltage, current, timestamp)", () => {
      const bytes = canonicalize(makeTestPayload());
      // From Python: canonicalize(_make_test_payload())[56:80].hex()
      const expected =
        "000000000000157c" + // voltage_mv = 5500
        "00000000000000f0" + // current_ma = 240
        "00000000000003e8"; // timestamp_ms = 1000
      expect(toHex(bytes.slice(56, 80))).toBe(expected);
    });

    it("throws when readings count is not 100", () => {
      const payload = makeTestPayload();
      payload.readings = payload.readings.slice(0, 50);
      expect(() => canonicalize(payload)).toThrow(/Expected 100 readings/);
    });
  });

  describe("bytesToFieldElements — 8 BE bytes → 1 BN254 field element", () => {
    it("produces 307 field elements from 2456 bytes", () => {
      const bytes = canonicalize(makeTestPayload());
      const elements = bytesToFieldElements(bytes);
      expect(elements.length).toBe(EXPECTED_FIELD_ELEMENTS);
      expect(elements.length).toBe(307);
    });

    it("first three elements match metadata uint64s", () => {
      const bytes = canonicalize(makeTestPayload());
      const elements = bytesToFieldElements(bytes);
      expect(elements[0]).toBe(42n); // device_id
      expect(elements[1]).toBe(1n); // session_id
      expect(elements[2]).toBe(1_778_000_000n); // epoch_start_ts
    });
  });

  describe("computePayloadHash — full pipeline matches edge Python bit-exact", () => {
    it("matches Python reference hash for _make_test_payload fixture", async () => {
      const hash = await computePayloadHash(makeTestPayload());
      // From edge/.venv/bin/python:
      //   compute_payload_hash(_make_test_payload()).hex()
      // This is the GOLDEN VALUE — if this fails, edge Python and aggregator TS
      // produce different hashes for the same input and the chain is broken.
      const expected =
        "0e2db2578df7ec8a1e3c536ee7462344faf86330e51a7c18b041c1060f8199df";
      expect(toHex(hash)).toBe(expected);
    });

    it("output is exactly 32 bytes", async () => {
      const hash = await computePayloadHash(makeTestPayload());
      expect(hash.length).toBe(32);
    });
  });
});
