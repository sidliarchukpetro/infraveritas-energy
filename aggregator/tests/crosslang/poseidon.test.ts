/**
 * Cross-language Poseidon parity tests.
 *
 * Verifies aggregator TypeScript Poseidon (src/verify/poseidon.ts) matches
 * Noir poseidon::bn254 bit-exact using golden vectors from
 * docs/specs/poseidon_test_vectors.json.
 *
 * If any vector here fails, edge Python ↔ aggregator TS ↔ Noir circuit hash
 * chain breaks — V3 submitProof will revert at the payload_hash check.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { poseidonSponge, hashN } from "../../src/verify/poseidon.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(
  __dirname,
  "../../../docs/specs/poseidon_test_vectors.json",
);

interface Vector {
  function: string;
  input?: string[];
  input_length?: number;
  input_pattern?: string;
  output: string;
}

interface VectorFile {
  vectors: Record<string, Vector>;
}

const vectors: VectorFile = JSON.parse(readFileSync(vectorsPath, "utf-8"));

function hex(b: bigint): string {
  return b.toString(16).padStart(64, "0");
}

function strip0x(s: string): string {
  return s.startsWith("0x") ? s.slice(2) : s;
}

describe("Poseidon cross-language parity (TS ↔ Noir ↔ Python)", () => {
  describe("hash_N — fixed-size hash (Noir poseidon::bn254::hash_N)", () => {
    const cases = ["hash_1", "hash_2", "hash_3", "hash_16"];
    for (const name of cases) {
      it(`matches Noir ${name}`, async () => {
        const v = vectors.vectors[name];
        if (!v?.input) throw new Error(`vector ${name} missing input`);
        const inputs = v.input.map((s) => BigInt(s));
        const got = await hashN(inputs);
        expect(hex(got)).toBe(strip0x(v.output));
      });
    }
  });

  describe("sponge — arbitrary-length hash (Noir poseidon::bn254::sponge, t=5 rate=4)", () => {
    // Coverage of sponge edge cases:
    //   sponge_4   — exact-rate boundary (1 permutation, no partial block)
    //   sponge_5   — rate+1 (1 full + 1 partial-block permutation)
    //   sponge_8   — 2×rate (exactly 2 permutations)
    //   sponge_17  — 4×rate+1 (4 full + 1 partial)
    //   sponge_100 — mid-size payload approximation (25 permutations)
    const cases = ["sponge_4", "sponge_5", "sponge_8", "sponge_17", "sponge_100"];
    for (const name of cases) {
      it(`matches Noir ${name}`, async () => {
        const v = vectors.vectors[name];
        if (v?.input_length === undefined) {
          throw new Error(`vector ${name} missing input_length`);
        }
        // input_pattern is "[1..N]" → BigInts 1n..Nn
        const inputs = Array.from({ length: v.input_length }, (_, i) =>
          BigInt(i + 1),
        );
        const got = await poseidonSponge(inputs);
        expect(hex(got)).toBe(strip0x(v.output));
      });
    }
  });
});
