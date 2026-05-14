/**
 * Noir v08 witness preparation and execution.
 *
 * Spec: docs/specs/aggregator_design.md §3.2.
 * Circuit: zk/circuits/v08/src/main.nr (compiled artifact at aggregator/circuits/v08.json).
 *
 * Pipeline: CanonicalPayload + signature + pubkey
 *   → compute payload_hash via Poseidon (matching edge)
 *   → compute total_energy_mwh as Σ(voltage_mv × current_ma) over 100 readings
 *   → format inputs into Noir-acceptable shape (Fields as hex strings, u8s as numbers)
 *   → noir.execute() → witness Uint8Array ready for bb.js
 */

import { Noir, type CompiledCircuit } from "@noir-lang/noir_js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  canonicalize,
  bytesToFieldElements,
  computePayloadHash,
  type CanonicalPayload,
} from "../verify/canonical.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUIT_PATH = resolve(__dirname, "../../circuits/v08.json");

const BN254_FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let cachedCircuit: CompiledCircuit | null = null;
let cachedNoir: Noir | null = null;

function loadCircuit(): CompiledCircuit {
  if (!cachedCircuit) {
    const raw = readFileSync(CIRCUIT_PATH, "utf-8");
    cachedCircuit = JSON.parse(raw) as CompiledCircuit;
  }
  return cachedCircuit;
}

export function getCompiledCircuit(): CompiledCircuit {
  return loadCircuit();
}

function getNoir(): Noir {
  if (!cachedNoir) {
    cachedNoir = new Noir(loadCircuit());
  }
  return cachedNoir;
}

export interface ProverInputs {
  /** Canonical payload with exactly 100 readings (the data edge signed). */
  payload: CanonicalPayload;
  /** P-256 signature, 64 bytes: r (32 BE) || s (32 BE). Must be low-s normalized. */
  signature: Uint8Array;
  /** P-256 public key, 64 bytes uncompressed: X (32 BE) || Y (32 BE). */
  pubkey: Uint8Array;
}

/**
 * Total energy proxy as enforced by circuit Check 4:
 *   total = Σ canonical_payload[7 + i*3] * canonical_payload[8 + i*3]  for i in 0..99
 *         = Σ voltage_mv * current_ma
 *
 * Real Wh/MWh conversion happens off-chain; circuit only checks the sum is correct.
 */
export function computeTotalEnergy(payload: CanonicalPayload): bigint {
  let total = 0n;
  for (const r of payload.readings) {
    total += r.voltage_mv * r.current_ma;
  }
  return total;
}

/** Encode bigint (possibly negative) as a hex Field element string. */
function toFieldHex(v: bigint): string {
  let n = v;
  if (n < 0n) {
    n = ((n % BN254_FIELD_SIZE) + BN254_FIELD_SIZE) % BN254_FIELD_SIZE;
  }
  return "0x" + n.toString(16);
}

/** Big-endian bytes → bigint. */
function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) {
    v = (v << 8n) | BigInt(b);
  }
  return v;
}

/**
 * Shape inputs into Noir's expected JSON form.
 * Field order MUST match main.nr v08 function signature.
 */
export async function prepareWitnessInputs(
  inputs: ProverInputs,
): Promise<Record<string, string | string[] | number[]>> {
  const { payload, signature, pubkey } = inputs;

  if (signature.length !== 64) {
    throw new Error(`signature must be 64 bytes (r || s), got ${signature.length}`);
  }
  if (pubkey.length !== 64) {
    throw new Error(
      `pubkey must be 64 bytes uncompressed (X || Y), got ${pubkey.length}`,
    );
  }
  if (payload.readings.length !== 100) {
    throw new Error(
      `payload must have exactly 100 readings, got ${payload.readings.length}`,
    );
  }

  const payloadHashBytes = await computePayloadHash(payload);
  const payloadHash = bytesToBigIntBE(payloadHashBytes);
  const totalEnergy = computeTotalEnergy(payload);

  const canonicalBytes = canonicalize(payload);
  const canonicalFields = bytesToFieldElements(canonicalBytes);

  return {
    device_id: toFieldHex(payload.device_id),
    session_id: toFieldHex(payload.session_id),
    epoch_start_ts: toFieldHex(payload.epoch_start_ts),
    lat_e7: toFieldHex(payload.lat_e7),
    lon_e7: toFieldHex(payload.lon_e7),
    light_level: toFieldHex(payload.light_level),
    tamper_flag: toFieldHex(payload.tamper_flag),
    payload_hash: toFieldHex(payloadHash),
    total_energy_mwh: toFieldHex(totalEnergy),
    canonical_payload: canonicalFields.map(toFieldHex),
    signature: Array.from(signature),
    pubkey_x: Array.from(pubkey.slice(0, 32)),
    pubkey_y: Array.from(pubkey.slice(32, 64)),
  };
}

export interface WitnessResult {
  /** Serialized witness bytes ready for UltraHonkBackend.generateProof(). */
  witness: Uint8Array;
  /** Circuit return values (empty tuple for v08; reserved). */
  returnValue: unknown;
}

/**
 * Execute the Noir circuit against the prepared inputs to produce a witness.
 * This is the heavy step that runs all 4 circuit checks (Poseidon, metadata
 * destructuring, P-256 verify, energy sum) and produces the wire assignments
 * the prover needs. ~31k ACIR opcodes for v08.
 */
export async function generateWitness(
  inputs: ProverInputs,
): Promise<WitnessResult> {
  const witnessInputs = await prepareWitnessInputs(inputs);
  const noir = getNoir();
  const { witness, returnValue } = await noir.execute(
    witnessInputs as unknown as Parameters<Noir["execute"]>[0],
  );
  return { witness, returnValue };
}
