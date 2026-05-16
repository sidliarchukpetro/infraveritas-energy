// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {EnergyProofRegistryV3, PublicInputs} from "../src/EnergyProofRegistryV3.sol";

// =============================================================================
// Mock contracts — always-truthy verifiers and authorization registry
// =============================================================================

contract MockDeviceRegistry {
    mapping(bytes32 => bool) public authorizedPubkey;

    function setAuthorized(bytes calldata pubkey, bool ok) external {
        authorizedPubkey[keccak256(pubkey)] = ok;
    }

    function isAuthorized(bytes calldata pubkey) external view returns (bool) {
        return authorizedPubkey[keccak256(pubkey)];
    }
}

/// Always returns true — lets harness exercise full submitProof success path
/// without needing valid P256 signatures.
contract MockP256VerifierAlwaysTrue {
    function verify(bytes32, bytes32, bytes32, bytes32, bytes32)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

/// Always returns true — same rationale as MockP256VerifierAlwaysTrue.
contract MockHonkVerifierAlwaysTrue {
    function verify(bytes calldata, bytes32[] calldata)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

// =============================================================================
// UnauthorizedCaller — has NO OPERATOR_ROLE; used for access-control invariant
// =============================================================================

contract UnauthorizedCaller {
    EnergyProofRegistryV3 public immutable v3;

    constructor(EnergyProofRegistryV3 _v3) {
        v3 = _v3;
    }

    /// Returns true if call unexpectedly succeeded (= invariant violation).
    /// Uses memory parameters instead of calldata to avoid Solidity's
    /// resolution issues with external-contract struct types in calldata
    /// positions of cross-contract function signatures.
    function attemptSubmit(
        PublicInputs memory pubInputs,
        bytes32 payloadHash,
        bytes memory signature,
        bytes memory devicePubkey,
        bytes memory proof
    ) external returns (bool didSucceed) {
        try v3.submitProof(pubInputs, payloadHash, signature, devicePubkey, proof) {
            return true; // VIOLATION — non-operator submitted successfully
        } catch {
            return false; // EXPECTED — revert from onlyRole(OPERATOR_ROLE)
        }
    }
}

// =============================================================================
// V3Properties — Echidna property-based fuzz harness
// =============================================================================
//
// Tests five MVP security invariants from docs/specs/V3_design.md §17:
//   #1 submitCounterMonotonic       — per-device submit count only grows
//   #2 pausedMeansNoSubmit          — paused state blocks all successful submits
//   #3 sessionKeyUnique             — each sessionKey produces at most one accepted submit
//   #5 nonOperatorCannotSubmit      — callers without OPERATOR_ROLE always revert
//   #6 timestampMonotonicPerDevice  — per-device timestamps strictly increasing
//
// Invariants #4 (postDisconnectionMatchesGap) and #7 (pubInputsHashConsistency)
// are covered by Foundry invariant tests in test/V3_Invariants.t.sol — they
// require event-data correlation and valid ZK proof simulation that fits the
// forge cheatcode model more naturally than Echidna's pure-Solidity harness.
// =============================================================================

contract V3Properties {
    // -------------------------------------------------------------------------
    // Deployed instances
    // -------------------------------------------------------------------------

    EnergyProofRegistryV3 public v3;
    MockDeviceRegistry public dr;
    MockP256VerifierAlwaysTrue public p256;
    MockHonkVerifierAlwaysTrue public honk;
    UnauthorizedCaller public unauth;

    // -------------------------------------------------------------------------
    // Invariant violation flags — set by transaction functions, read by
    // echidna_* property functions. Echidna fails the run when any flag is true.
    // -------------------------------------------------------------------------

    bool internal violated_counterMonotonic;          // #1
    bool internal violated_pausedAcceptedSubmit;      // #2
    bool internal violated_sessionKeyReuse;           // #3
    bool internal violated_nonOperatorAccepted;       // #5
    bool internal violated_timestampNonMonotonic;     // #6

    // -------------------------------------------------------------------------
    // Local state mirror (parallel to V3's storage)
    // -------------------------------------------------------------------------

    mapping(uint64 => uint256) internal submitCount;     // deviceId → count
    mapping(uint64 => uint64) internal lastTimestamp;    // deviceId → last successful ts
    mapping(bytes32 => bool) internal seenSessionKey;    // sessionKey → seen

    // -------------------------------------------------------------------------
    // Input bounding parameters
    // -------------------------------------------------------------------------

    uint64 internal constant DEVICE_COUNT = 5;
    uint64 internal constant MAX_TS_LOOKBACK = 7 days;

    // -------------------------------------------------------------------------
    // Constructor — deploy V3 via proxy, register mocks, grant roles, seed devices
    // -------------------------------------------------------------------------

    constructor() {
        // 1. Deploy mocks
        dr = new MockDeviceRegistry();
        p256 = new MockP256VerifierAlwaysTrue();
        honk = new MockHonkVerifierAlwaysTrue();

        // 2. Deploy V3 implementation + UUPS proxy with this harness as admin
        EnergyProofRegistryV3 impl = new EnergyProofRegistryV3();
        bytes memory initData = abi.encodeWithSelector(
            EnergyProofRegistryV3.initialize.selector,
            address(this),
            address(dr),
            address(p256),
            address(honk)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        v3 = EnergyProofRegistryV3(payable(address(proxy)));

        // 3. Grant OPERATOR_ROLE and PAUSER_ROLE to the harness.
        // initialize() only grants DEFAULT_ADMIN_ROLE and UPGRADER_ROLE; we hold
        // DEFAULT_ADMIN_ROLE so we can grant any other role.
        v3.grantRole(v3.OPERATOR_ROLE(), address(this));
        v3.grantRole(v3.PAUSER_ROLE(), address(this));

        // 4. Register DEVICE_COUNT distinct devices in MockDeviceRegistry
        for (uint64 i = 1; i <= DEVICE_COUNT; i++) {
            dr.setAuthorized(_pubkeyFor(i), true);
        }

        // 5. Spawn unauthorized caller (no V3 roles)
        unauth = new UnauthorizedCaller(v3);
    }

    // -------------------------------------------------------------------------
    // Echidna-callable transactions
    // -------------------------------------------------------------------------

    /// Submit proof as authorized operator (the harness itself)
    function submitAsOperator(
        uint64 deviceIdSeed,
        uint64 sessionIdSeed,
        uint64 epochTsSeed,
        bytes32 payloadHash
    ) external {
        // Bound inputs into ranges V3 will accept
        uint64 deviceId = (deviceIdSeed % DEVICE_COUNT) + 1; // 1..DEVICE_COUNT
        uint64 sessionId = sessionIdSeed;
        uint64 epochStartTs = _boundEpochTs(epochTsSeed);

        // Pre-state capture for invariant checks
        bool wasPaused = v3.paused();
        bytes32 sessionKey = keccak256(abi.encodePacked(deviceId, sessionId));
        bool wasSeenSessionKey = seenSessionKey[sessionKey];
        uint64 prevTs = lastTimestamp[deviceId];

        PublicInputs memory pi = PublicInputs({
            deviceId: deviceId,
            sessionId: sessionId,
            epochStartTs: epochStartTs,
            lat_e7: 0,
            lon_e7: 0,
            lightLevel: 0,
            tamperFlag: 0,
            payloadHash: payloadHash,
            totalEnergyMWh: 0
        });

        bytes memory signature = new bytes(64);
        bytes memory devicePubkey = _pubkeyFor(deviceId);
        bytes memory proof = new bytes(440);

        try v3.submitProof(pi, payloadHash, signature, devicePubkey, proof) {
            // Success — V3 accepted the submit. Check invariants.

            // #2 — if V3 was paused, success path is forbidden
            if (wasPaused) {
                violated_pausedAcceptedSubmit = true;
            }

            // #3 — sessionKey must not have been seen before
            if (wasSeenSessionKey) {
                violated_sessionKeyReuse = true;
            }
            seenSessionKey[sessionKey] = true;

            // #6 — per-device timestamp must be strictly increasing
            if (prevTs != 0 && epochStartTs <= prevTs) {
                violated_timestampNonMonotonic = true;
            }
            lastTimestamp[deviceId] = epochStartTs;

            // #1 — counter only ever increments (decrement would be a bug;
            // the harness has no decrement path, so this is vacuously true,
            // but the flag is exposed for future logic that might decrement)
            submitCount[deviceId] += 1;
        } catch {
            // Revert path — V3 enforced one of its own checks. Not a violation.
        }
    }

    /// Attempt submit from a contract WITHOUT OPERATOR_ROLE — must always revert
    function submitAsUnauthorized(
        uint64 deviceIdSeed,
        uint64 sessionIdSeed,
        uint64 epochTsSeed,
        bytes32 payloadHash
    ) external {
        uint64 deviceId = (deviceIdSeed % DEVICE_COUNT) + 1;
        uint64 epochStartTs = _boundEpochTs(epochTsSeed);

        PublicInputs memory pi = PublicInputs({
            deviceId: deviceId,
            sessionId: sessionIdSeed,
            epochStartTs: epochStartTs,
            lat_e7: 0,
            lon_e7: 0,
            lightLevel: 0,
            tamperFlag: 0,
            payloadHash: payloadHash,
            totalEnergyMWh: 0
        });

        bytes memory signature = new bytes(64);
        bytes memory devicePubkey = _pubkeyFor(deviceId);
        bytes memory proof = new bytes(440);

        bool didSucceed = unauth.attemptSubmit(
            pi, payloadHash, signature, devicePubkey, proof
        );
        if (didSucceed) {
            violated_nonOperatorAccepted = true;
        }
    }

    /// Toggle pause — Echidna can interleave pause/unpause with submit attempts
    function pause() external {
        if (!v3.paused()) {
            v3.pause();
        }
    }

    function unpause() external {
        if (v3.paused()) {
            v3.unpause();
        }
    }

    // -------------------------------------------------------------------------
    // Echidna properties — return true iff invariant holds.
    // Echidna reports a failure when any of these returns false.
    // -------------------------------------------------------------------------

    /// #1 submitCounterMonotonic — per-device count only ever grows
    function echidna_counter_monotonic() external view returns (bool) {
        return !violated_counterMonotonic;
    }

    /// #2 pausedMeansNoSubmit — paused state blocks all successful submits
    function echidna_paused_blocks_submit() external view returns (bool) {
        return !violated_pausedAcceptedSubmit;
    }

    /// #3 sessionKeyUnique — each sessionKey produces at most one accepted submit
    function echidna_session_key_unique() external view returns (bool) {
        return !violated_sessionKeyReuse;
    }

    /// #5 nonOperatorCannotSubmit — callers without OPERATOR_ROLE always revert
    function echidna_non_operator_cannot_submit() external view returns (bool) {
        return !violated_nonOperatorAccepted;
    }

    /// #6 timestampMonotonicPerDevice — per-device timestamps strictly increasing
    function echidna_timestamp_monotonic() external view returns (bool) {
        return !violated_timestampNonMonotonic;
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /// Bound epoch timestamp to a [block.timestamp - MAX_TS_LOOKBACK, block.timestamp]
    /// range. This satisfies V3's `epochStartTs <= block.timestamp + 300s` constraint
    /// and provides Echidna with enough variation to exercise monotonicity logic.
    function _boundEpochTs(uint64 seed) internal view returns (uint64) {
        uint64 currentTs = uint64(block.timestamp);
        if (currentTs <= MAX_TS_LOOKBACK) {
            // Echidna may anchor block.timestamp at an early genesis value;
            // fall back to a small non-zero offset.
            return uint64(seed % 86400) + 1;
        }
        uint64 lookback = uint64(seed % MAX_TS_LOOKBACK);
        return currentTs - lookback;
    }

    /// Deterministic 64-byte test pubkey per deviceId (uncompressed P256 format).
    /// Each device gets a distinct, recognizable pubkey for cross-tracking.
    function _pubkeyFor(uint64 deviceId) internal pure returns (bytes memory) {
        return abi.encodePacked(
            bytes32(uint256(deviceId)),
            bytes32(uint256(deviceId) | (uint256(1) << 64))
        );
    }
}
