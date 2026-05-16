/**
 * UltraHonk proof generation and local verification via @aztec/bb.js v5.0.0-nightly.20260324.
 *
 * Spec: docs/specs/aggregator_design.md §3.3.
 *
 * Honk public-inputs model (verified against contracts/vendor/HonkVerifier.sol
 * via grep on 2026-05-14):
 *   - Verifier constant NUMBER_OF_PUBLIC_INPUTS = 17 (internal)
 *   - Verifier constant PAIRING_POINTS_SIZE = 8 G1 points (internal)
 *   - External API surface = 17 - 8 = 9 inputs (matches V3.PublicInputs and main.nr)
 *   - bb.js packs pairing points inside `proof` bytes; aggregator never builds them manually.
 *
 * Verifier target — critical:
 *   - Default bb.js target is 'noir-recursive' (Poseidon transcript, for in-Noir recursion).
 *   - HonkVerifier.sol on-chain uses keccak transcript → MUST pass `verifierTarget: 'evm'`
 *     on BOTH generateProof and verifyProof. Mismatch = proof rejects with no useful error.
 */

import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { getCompiledCircuit } from "./witness.js";

const EVM_OPTIONS = { verifierTarget: "evm" as const };

let cachedBb: Barretenberg | null = null;
let cachedBackend: UltraHonkBackend | null = null;

async function getBb(): Promise<Barretenberg> {
  if (!cachedBb) {
    cachedBb = await Barretenberg.new();
  }
  return cachedBb;
}

async function getBackend(): Promise<UltraHonkBackend> {
  if (!cachedBackend) {
    const circuit = getCompiledCircuit();
    const bb = await getBb();
    cachedBackend = new UltraHonkBackend(circuit.bytecode, bb);
  }
  return cachedBackend;
}

export interface HonkProof {
  /** Raw proof bytes (contains pairing points internally). Sent to V3.submitProof(). */
  proof: Uint8Array;
  /** 9 public input field elements as hex strings, in V3.PublicInputs order. */
  publicInputs: string[];
}

/**
 * Generate UltraHonk proof from a Noir witness using EVM-compatible transcript.
 *
 * Heavy operation (~1 second on modern CPU for v08 circuit per project spec).
 * Caller should run this on a queue worker, not inline with HTTP requests.
 */
export async function generateProof(witness: Uint8Array): Promise<HonkProof> {
  const backend = await getBackend();
  const { proof, publicInputs } = await backend.generateProof(witness, EVM_OPTIONS);
  if (publicInputs.length !== 9) {
    throw new Error(
      `Expected 9 external public inputs from bb.js, got ${publicInputs.length} ` +
        `(check circuit NUMBER_OF_PUBLIC_INPUTS - PAIRING_POINTS_SIZE = 17 - 8 = 9)`,
    );
  }
  return { proof, publicInputs };
}

/**
 * Local proof verification — defensive check before paying gas to submit on-chain.
 *
 * Uses the same EVM target as generation. V3 contract runs the same math
 * via HonkVerifier.sol; if this passes, on-chain verification should pass too
 * (modulo bytecode mismatch — circuit artifact must match deployed HonkVerifier).
 */
export async function verifyProofLocally(proof: HonkProof): Promise<boolean> {
  const backend = await getBackend();
  return backend.verifyProof(
    {
      proof: proof.proof,
      publicInputs: proof.publicInputs,
    },
    EVM_OPTIONS,
  );
}

/**
 * Release WASM resources held by Barretenberg (call on graceful shutdown).
 *
 * The UltraHonkBackend doesn't own resources — Barretenberg does. Destroying bb
 * invalidates any cached backend that referenced it.
 */
export async function destroyBackends(): Promise<void> {
  if (cachedBb) {
    await cachedBb.destroy();
    cachedBb = null;
    cachedBackend = null;
  }
}
