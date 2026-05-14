/**
 * Poseidon hash on BN254. Matches edge/hal/poseidon.py bit-exact.
 *
 * Spec: docs/specs/poseidon_params.md v1.1
 * Construction: sponge t=5, rate=4, capacity=1, output[1].
 * Permutation: Circom-compatible x5_5 (Hades, alpha=5, 8 full + 60 partial rounds).
 * Cross-language verified against Noir poseidon::bn254::sponge and Python sponge
 * using docs/specs/poseidon_test_vectors.json.
 */

import { buildPoseidon } from "circomlibjs";

const STATE_SIZE = 5;
const RATE = 4;
const CAPACITY = 1;
const OUTPUT_POSITION = 1;

export const BN254_FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// circomlibjs Field interface (untyped in upstream)
interface PoseidonF {
  e(x: bigint): unknown;
  toObject(x: unknown): bigint;
}

interface PoseidonFn {
  (inputs: unknown[], init?: unknown, nOut?: number): unknown;
  F: PoseidonF;
}

let cached: PoseidonFn | null = null;

async function instance(): Promise<PoseidonFn> {
  if (!cached) {
    cached = (await buildPoseidon()) as PoseidonFn;
  }
  return cached;
}

/**
 * Poseidon sponge hash over arbitrary-length BN254 field element input.
 *
 * Matches edge/hal/poseidon.py::poseidon_sponge bit-exact. Pre-image must be
 * the same sequence of field elements on both sides — see canonical.ts for the
 * 2456-byte payload → 307 field-element packing rule.
 *
 * Sponge mechanic (mirror of Noir's poseidon::bn254::sponge):
 *   1. state[0..5] initialized to zeros
 *   2. absorb each input into state[1..5] (rate positions); state[0] is capacity
 *   3. when 4 inputs absorbed → permute x5_5 with state[0] as capacity init
 *   4. after all inputs, if partial block remains → final permutation
 *   5. output = state[1] after final permutation
 */
export async function poseidonSponge(msg: bigint[]): Promise<bigint> {
  const poseidon = await instance();
  const F = poseidon.F;

  let state: bigint[] = new Array(STATE_SIZE).fill(0n);
  let i = 0;

  const permute = (): void => {
    // Pass rate-portion of state as the 4 inputs, capacity-portion (state[0])
    // as the init value. Request full t=5 output to get the entire permuted state.
    const rateInputs = state.slice(CAPACITY).map((b) => F.e(b));
    const capInit = F.e(state[0]!);
    const permuted = poseidon(rateInputs, capInit, STATE_SIZE) as unknown[];
    state = permuted.map((f) => F.toObject(f));
  };

  for (const m of msg) {
    const idx = CAPACITY + i;
    state[idx] = (state[idx]! + m) % BN254_FIELD_SIZE;
    i++;
    if (i === RATE) {
      permute();
      i = 0;
    }
  }
  if (i !== 0) {
    permute();
  }
  return state[OUTPUT_POSITION]!;
}

/**
 * Fixed-size Poseidon for 1..16 inputs. Matches Noir's poseidon::bn254::hash_N
 * and edge/hal/poseidon.py::hash_n.
 *
 * Uses circomlibjs's `poseidon(inputs)` which auto-selects t = inputs.length + 1.
 * Result is state[0] of the permuted state (circomlibjs default nOut=1).
 */
export async function hashN(inputs: bigint[]): Promise<bigint> {
  if (inputs.length < 1 || inputs.length > 16) {
    throw new Error(`hashN supports 1..16 inputs, got ${inputs.length}`);
  }
  const poseidon = await instance();
  const F = poseidon.F;
  const result = poseidon(inputs.map((b) => F.e(b)));
  return F.toObject(result);
}
