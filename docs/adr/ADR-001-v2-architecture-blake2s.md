# ADR-001: V2 Architecture with Hash-Out Pattern and Blake2s

**Status:** Accepted
**Date:** 2026-05-11
**Authors:** Petro Sydliarchuk (founder), Claude (architectural review)
**Reviewers pending:** Oleksandr Sydliarchuk (CTO, security review)

## Context

Phase A.2.2 of the InfraVeritas v2.0 hardening plan required a decision on how to achieve trustless aggregator architecture — the ability for any party to relay device-signed payloads to the smart contract without being able to forge or substitute readings.

Three architectural variants were on the table:

**V1 (Status quo + observability):** Keep ECDSA signature verification in aggregator (TypeScript verify.ts). Trust model relies on aggregator operator. Trustless property deferred to a later phase.

**V2 (Hash-out + standalone P256Verifier):** Circuit computes `hash(readings + metadata)` as public output. Smart contract calls separate P256Verifier to verify device ECDSA signature against this hash. Trustless: aggregator cannot substitute readings (zk proof would fail) or forge signature (no device key).

**V3 (ECDSA inside circuit):** Full `ecdsa_secp256r1::verify_signature` inside the Noir circuit. Single proof verifies everything. Trustless via monolithic proof.

Initial plan from v2 hardware document leaned toward V3 by inertia. On review, the architectural choice was not consciously made.

## Decision

Adopt **V2 (Hash-out pattern) with blake2s** as the hash function.

Rationale (in priority order):

1. **Operational safety.** V3 risked OOM in 6 GB WSL constraint due to ECDSA gate cost (~12-15K additional constraints, RAM scaling unpredictable). V2 measured at 180 MB peak — comfortable margin.

2. **Modularity.** V2 separates zk-validity of computation and ECDSA-validity of authorship into two independent contract subsystems. Future upgrades (better P256Verifier, hash function migration) touch only one component.

3. **Battle-tested primitives.** P256Verifier contracts (Daimo's, Renaud Dubois's) are production-grade in Coinbase Smart Wallet, Soneium, multiple ZK rollups. V3's ECDSA-in-Noir uses newer stdlib code less battle-tested at scale.

4. **Time.** V2 estimated 2-3 weeks integration vs V3 at 3-5 weeks.

### Hash function: blake2s (not keccak256)

Original plan assumed keccak256 for Ethereum-native compatibility. Discovery during A.2.2 spike: `keccak256` is NOT in Noir 1.0.0-beta.20 stdlib. Only `keccakf1600` (the underlying permutation) is exposed. Full keccak256 would require either external library dependency or manual implementation (~80 lines Noir).

Re-analysis of architecture revealed: the smart contract does NOT recompute the hash. It only uses the hash as an opaque 32-byte digest input to ECDSA verification. ATECC608B (future HSM) and P256Verifier (Daimo, Dubois) both accept arbitrary 32-byte digests — no specific hash function is mandated.

Therefore: any in-stdlib full hash function works. Blake2s chosen because:
- Available in Noir 1.0.0-beta.20 stdlib (`std::hash::blake2s`)
- Cheaper in zk than keccak256 (~13K constraints vs estimated ~25K)
- Cryptographically modern and secure
- ATECC608B compatible (signs precomputed digest)

Trade-off accepted: blake2s is non-standard for Ethereum (less common than keccak/sha256). This must be documented in user-facing README and any partner integration material. Auditors should be pointed to this ADR for rationale.

## Empirical Validation

Phase A.2.2 spike (v07-spike circuit, identical to v06 + blake2s of 1600-byte readings array as public output):

| Metric | v06 baseline | v07-spike | Status |
|---|---|---|---|
| acir_opcodes | ~500-1000 (est.) | 13,273 | OK |
| circuit_size | ~5-8K (est.) | 101,139 | OK |
| N (FFT subgroup) | 8192 | 131,072 | OK, doesn't affect Verifier.sol size |
| Peak prove RAM | ~38 MB | 180 MB | OK (3% of 6 GB ceiling) |
| Prove wall clock | ~0.3s (est.) | 0.98s | OK |
| Verifier.sol source | 101,605 bytes | 101,609 bytes | Essentially identical |
| Verifier.sol bytecode | (working under 24576) | 24,201 bytes | OK, margin 375 bytes |

HonkVerifier source is essentially constant across N because the verifier is "universal" — sumcheck rounds run in a Solidity loop (not unrolled), VK structure has fixed element count.

## Consequences

### Positive
- Trustless aggregator achieved
- Modular contract architecture (HonkVerifier + P256Verifier + DeviceRegistry as independent components)
- No external Noir library dependency
- Edge device hardware path (ATECC608B P-256 signing) unchanged
- Sub-second prove time confirmed

### Negative
- Verifier.sol bytecode margin is thin (375 bytes / 1.5% headroom at 24,201/24,576). Any future schema change (additional public inputs, new constants) must be re-verified against bytecode size. If exceeded, library pattern (factor verifier into deployed library) becomes mandatory.
- Blake2s is unusual choice for Ethereum-aligned protocols. Requires explicit documentation and may raise questions from partners or auditors. Counter-argument prepared: functionally equivalent at contract boundary, cryptographically modern, ATECC608B compatible.
- On-chain verify gas not yet measured. Expected range 400-600K gas vs v06's ~280K (4 additional sumcheck rounds at log2(N)=17 vs 13). Acceptable for prototype but should be measured before mainnet planning.

### Neutral
- N stepped from 8192 to 131,072. Does not affect Verifier.sol but proves are heavier (180 MB vs 38 MB). Still well within aggregator hardware capacity.

## Alternatives Rejected

**V1 (deferred trustless):** Same work would need to be done later when Witness Network (Phase 3) requires trustless aggregator. Doing it now while circuit context is fresh is cheaper than retrofitting.

**V3 (ECDSA in circuit):** OOM risk in WSL, longer timeline, less modular for future evolution. Marginal benefits (single proof, marginally cheaper gas if N matched) outweighed by real costs.

**Keccak256 (in any variant of V2):** Not available in Noir 1.0.0-beta.20 stdlib without external library or manual implementation. After re-analysis, no contract-level requirement mandates keccak256 over alternative full hash functions. Engineering cost not justified.

## Outstanding Items

1. **On-chain verify gas measurement.** Defer until v07 Sepolia deployment. Target: < 800K gas per submitProof on mainnet for economic acceptability.
2. **Verifier.sol bytecode margin monitoring.** Document in main README. Any schema change requires bytecode size re-verification.
3. **Oleksandr (CTO) security review.** Required before V2 full integration on Sepolia testnet. Specific review items: DeviceRegistry pubkey storage pattern, P256Verifier implementation choice (Daimo vs Renaud Dubois), aggregator changes (signature passed via submitProof).

## References

- Phase A.2.2 spike measurement chat: 11 May 2026 working session
- Noir stdlib v1.0.0-beta.20 hash module: https://github.com/noir-lang/noir/blob/v1.0.0-beta.20/noir_stdlib/src/hash/mod.nr
- USPTO Provisional Patent #63/876,031 (architectural elements covered by patent)