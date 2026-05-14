/**
 * Canonical payload serialization and Poseidon hash computation.
 *
 * Matches edge/hal/canonical.py bit-exact. Pre-image must be identical on both
 * sides — any mismatch breaks signature verification on-chain.
 *
 * Encoding: 2456 canonical bytes → 307 field elements (8 BE bytes per uint64
 * → 1 BN254 field element) → Poseidon sponge → 32-byte digest.
 *
 * Field order MUST match V3.PublicInputs struct order and Noir circuit public
 * input order (see docs/specs/V3_design.md §11 PublicInputs and zk/circuits/v08/src/main.nr).
 */

import { poseidonSponge } from "./poseidon.js";

// Expected number of readings per epoch (10 Hz × 10 seconds)
export const READINGS_PER_PAYLOAD = 100;

// Byte size per reading: 3 × uint64 big-endian = 24 bytes
export const READING_BYTES = 24;

// Byte size of payload metadata before readings:
// device_id (8) + session_id (8) + epoch_start_ts (8) + lat_e7 (8) + lon_e7 (8)
// + light_level (8) + tamper_flag (8) = 56 bytes
export const METADATA_BYTES = 56;

// Total payload size: 56 + 100 × 24 = 2456 bytes
export const EXPECTED_PAYLOAD_BYTES =
  METADATA_BYTES + READINGS_PER_PAYLOAD * READING_BYTES;

// 2456 bytes / 8 bytes per field element = 307 field elements
export const EXPECTED_FIELD_ELEMENTS = EXPECTED_PAYLOAD_BYTES / 8;

export interface Reading {
  voltage_mv: bigint;
  current_ma: bigint;
  timestamp_ms: bigint;
}

export interface CanonicalPayload {
  device_id: bigint;
  session_id: bigint;
  epoch_start_ts: bigint;
  /** Latitude × 10^7, signed. Two's complement when negative. */
  lat_e7: bigint;
  /** Longitude × 10^7, signed. Two's complement when negative. */
  lon_e7: bigint;
  light_level: bigint;
  tamper_flag: bigint;
  /** Exactly 100 readings. */
  readings: Reading[];
}

/**
 * Serialize payload deterministically into 2456 canonical bytes.
 *
 * Encoding rules:
 *   - All integers big-endian (network byte order)
 *   - lat_e7, lon_e7 signed 64-bit (two's complement via setBigInt64)
 *   - All other metadata fields unsigned 64-bit
 *   - Readings appended in order, no length prefix (count fixed at 100)
 *
 * Any change to field order or encoding here breaks signature verification.
 */
export function canonicalize(payload: CanonicalPayload): Uint8Array {
  if (payload.readings.length !== READINGS_PER_PAYLOAD) {
    throw new Error(
      `Expected ${READINGS_PER_PAYLOAD} readings, got ${payload.readings.length}`,
    );
  }
  const buf = new Uint8Array(EXPECTED_PAYLOAD_BYTES);
  const view = new DataView(buf.buffer);
  let offset = 0;

  view.setBigUint64(offset, payload.device_id, false);
  offset += 8;
  view.setBigUint64(offset, payload.session_id, false);
  offset += 8;
  view.setBigUint64(offset, payload.epoch_start_ts, false);
  offset += 8;
  // signed — DataView.setBigInt64 handles two's complement automatically
  view.setBigInt64(offset, payload.lat_e7, false);
  offset += 8;
  view.setBigInt64(offset, payload.lon_e7, false);
  offset += 8;
  view.setBigUint64(offset, payload.light_level, false);
  offset += 8;
  view.setBigUint64(offset, payload.tamper_flag, false);
  offset += 8;

  for (const r of payload.readings) {
    view.setBigUint64(offset, r.voltage_mv, false);
    offset += 8;
    view.setBigUint64(offset, r.current_ma, false);
    offset += 8;
    view.setBigUint64(offset, r.timestamp_ms, false);
    offset += 8;
  }

  if (offset !== EXPECTED_PAYLOAD_BYTES) {
    throw new Error(
      `Canonical encoding wrong size: ${offset} != ${EXPECTED_PAYLOAD_BYTES}`,
    );
  }
  return buf;
}

/**
 * Unpack canonical bytes into BN254 field elements.
 *
 * Each 8-byte big-endian chunk becomes one bigint (which fits in BN254's
 * 254-bit field trivially since uint64 < 2^64 < 2^254). 2456 bytes → 307 elements.
 *
 * This is the input to the Poseidon sponge — see poseidon.ts and matches
 * Noir circuit's `canonical_payload: [Field; 307]` private input.
 */
export function bytesToFieldElements(bytes: Uint8Array): bigint[] {
  if (bytes.length % 8 !== 0) {
    throw new Error(
      `Bytes length must be multiple of 8, got ${bytes.length}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const elements: bigint[] = new Array(bytes.length / 8);
  for (let i = 0; i < bytes.length; i += 8) {
    elements[i / 8] = view.getBigUint64(i, false);
  }
  return elements;
}

/**
 * Compute 32-byte Poseidon payload hash from a CanonicalPayload.
 *
 * Pipeline: payload → canonicalize → bytesToFieldElements → poseidonSponge → 32-byte BE.
 * Matches edge/hal/canonical.py::compute_payload_hash bit-exact.
 *
 * Output is what edge signs with P-256 (HSM, slot 0) and what V3 contract
 * checks against the Honk proof's payload_hash public input.
 */
export async function computePayloadHash(
  payload: CanonicalPayload,
): Promise<Uint8Array> {
  const canonicalBytes = canonicalize(payload);
  const fieldElements = bytesToFieldElements(canonicalBytes);
  if (fieldElements.length !== EXPECTED_FIELD_ELEMENTS) {
    throw new Error(
      `Expected ${EXPECTED_FIELD_ELEMENTS} field elements, got ${fieldElements.length}`,
    );
  }
  const hash = await poseidonSponge(fieldElements);
  return bigintToBytesBE(hash, 32);
}

/** Convert bigint to fixed-length big-endian Uint8Array. */
function bigintToBytesBE(value: bigint, byteLength: number): Uint8Array {
  if (value < 0n) {
    throw new Error("bigintToBytesBE: negative values not supported");
  }
  const out = new Uint8Array(byteLength);
  let v = value;
  for (let i = byteLength - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) {
    throw new Error(
      `bigintToBytesBE: value 0x${value.toString(16)} overflows ${byteLength} bytes`,
    );
  }
  return out;
}
