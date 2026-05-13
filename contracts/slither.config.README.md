# Slither Configuration — Rationale

This file documents why each detector in `slither.config.json` is suppressed.
JSON does not support comments, hence this companion file.

## detectors_to_exclude

### timestamp
**Code:** `EnergyProofRegistryV3.submitProof` line 180.
`pubInputs.epochStartTs > block.timestamp + MAX_EPOCH_FUTURE_DRIFT` (300 seconds).

**Why suppressed:** Validator manipulation of `block.timestamp` is bounded to
roughly 15 seconds in practice — well below the 5-minute drift tolerance. The
comparison is part of CHECK 6 (Epoch sanity) per V3_design.md §11, designed
to allow GPS/clock drift, not enforce strict timing. By-design.

### unused-state
**Code:** `EnergyProofRegistryV3.__gap` line 67 (`uint256[49] private __gap`).

**Why suppressed:** Standard OZ UUPS storage gap pattern. The reservation is
intentionally unused in V3 — to be consumed by future V4+ storage extensions
without breaking storage layout. "Never used" is the entire point. Pattern
documented in OZ docs and repeated across every OZ upgradeable contract.

### assembly
**Code:** `EnergyProofRegistryV3.submitProof` lines 227-232.
`assembly ("memory-safe") { r := calldataload(...); ... }`.

**Why suppressed:** Memory-safe assembly that extracts `r`, `s`, `pubKeyX`,
`pubKeyY` from `calldata`-located `signature` and `devicePubkey` (both `bytes
calldata`). Gas optimization to avoid Solidity's higher-level bytes slicing.
The `memory-safe` annotation tells the compiler this block respects memory
rules, allowing the optimizer to inline it without restrictions.

### naming-convention
**Code:** `__gap` (snake_case with leading underscore).

**Why suppressed:** Slither expects `mixedCase` but `__gap` follows OZ's
established convention for storage gaps across all upgradeable contracts.
Renaming would diverge from the de-facto standard recognized by every Solidity
auditor.

### solc-version
**Why suppressed:** Solc 0.8.28 is fixed and known. Slither's default check
flags any non-pinned version range, but we use exact pragma — false positive
for the way Slither phrases the warning at this version.

### pragma
**Why suppressed:** Related to `solc-version`. We pin `pragma solidity 0.8.28;`
in every file — Slither's broader pragma checker treats this as a style note.

### low-level-calls
**Why suppressed:** Used in `test/mocks/MaliciousVerifier.sol` for legitimate
reentrancy attack simulation via `address(target).staticcall(...)`. Production
contract `src/EnergyProofRegistryV3.sol` uses only high-level external calls
through typed interfaces (`IDeviceRegistry`, `IP256Verifier`, `IHonkVerifier`).
Filter `filter_paths` already excludes `test/`, but the detector exclusion
makes the intent explicit.

## filter_paths
- `lib/` — OZ and forge-std dependencies, not our code.
- `test/` — test code, irrelevant for production security audit.
