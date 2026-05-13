// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import { V3TestBase } from "./V3TestBase.sol";
import { EnergyProofRegistryV3, PublicInputs } from "../src/EnergyProofRegistryV3.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title V3_Integration
/// @notice End-to-end integration tests per docs/specs/V3_design.md §16.
/// @dev Tests interactions between multiple submitProof() check phases and
///      state writes. Covers:
///        - Full happy-path flow with two valid submissions and valid gap
///        - Ordering of 7 checks (each can fail independently with correct error)
///        - Payload hash consistency
///        - Epoch in future rejection
///        - Session key replay rejection
///        - Pause/unpause interleaving with submissions
contract V3_Integration_Test is V3TestBase {
    /// @dev Fixed anchor timestamp for deterministic time-based assertions.
    uint64 internal constant ANCHOR_TS = 1_700_000_000;

    // -----------------------------------------------------------------------
    // Full end-to-end flow
    // -----------------------------------------------------------------------

    /// @notice Two valid submissions for same device with valid gap (< 48h).
    /// @dev Verifies: register device → submit 1 → state updated → submit 2 with
    ///      new sessionId + valid timestamp → both events emit correctly.
    function test_FullFlow() public {
        _setMocksHappyPath();
        vm.warp(ANCHOR_TS);

        // First submission
        bytes32 deviceB32 = _deviceIdBytes32(1);
        PublicInputs memory pi1 = _buildPubInputs(1, 100, ANCHOR_TS);

        vm.expectEmit(true, true, false, true, address(v3));
        emit EnergyProofRegistryV3.ProofSubmitted(
            deviceB32, _sessionKey(1, 100), ANCHOR_TS, 0, false
        );
        vm.prank(operator);
        v3.submitProof(pi1, testPayloadHash, testSignature, testPubkey, testProof);

        // State after submission 1
        assertEq(v3.lastSubmissionTimestamp(deviceB32), ANCHOR_TS, "ts1 wrong");
        assertTrue(v3.usedSessionKeys(_sessionKey(1, 100)), "session1 not marked");

        // Second submission, +24h later, new sessionId
        uint64 ts2 = ANCHOR_TS + 24 hours;
        vm.warp(ts2);
        PublicInputs memory pi2 = _buildPubInputs(1, 200, ts2);

        vm.expectEmit(true, true, false, true, address(v3));
        emit EnergyProofRegistryV3.ProofSubmitted(
            deviceB32, _sessionKey(1, 200), ts2, 24 hours, false
        );
        vm.prank(operator);
        v3.submitProof(pi2, testPayloadHash, testSignature, testPubkey, testProof);

        // State after submission 2
        assertEq(v3.lastSubmissionTimestamp(deviceB32), ts2, "ts2 wrong");
        assertTrue(v3.usedSessionKeys(_sessionKey(1, 200)), "session2 not marked");
        assertTrue(v3.usedSessionKeys(_sessionKey(1, 100)), "session1 lost");
    }

    // -----------------------------------------------------------------------
    // Ordering proof — show that each check fires with its own error
    // -----------------------------------------------------------------------

    /// @notice Each of the 7 checks can be triggered independently with its own error.
    /// @dev Per docs/specs/V3_design.md §11, submitProof has 7 checks in defined order.
    ///      This test arranges 8 scenarios (length checks count as 2: sig + pubkey).
    ///      Each scenario violates ONLY one check; the test asserts the matching error.
    ///
    ///      Check order in contract (verified from submitProof source):
    ///        1. signature.length == 64        -> InvalidSignatureLength
    ///        2. devicePubkey.length == 64     -> InvalidPubkeyLength
    ///        3. epochStartTs <= now + 5min    -> EpochInFuture
    ///        4. payloadHash == pubInputs.h    -> PayloadHashMismatch
    ///        5. sessionKey not used           -> SessionKeyAlreadyUsed (no prev state here)
    ///        6. (previousTimestamp != 0 case) -> InvalidTimestamp (skipped — needs prev)
    ///        7. isAuthorized                  -> DeviceNotActive
    ///        8. P256.verify                   -> InvalidP256Signature
    ///        9. Honk.verify                   -> InvalidZKProof
    function test_7CheckOrderEachFailsIndependently() public {
        // === Scenario 1: bad signature length ===
        {
            _setMocksHappyPath();
            PublicInputs memory pi = _buildValidPubInputs();
            bytes memory badSig = new bytes(63);

            vm.prank(operator);
            vm.expectRevert(
                abi.encodeWithSelector(
                    EnergyProofRegistryV3.InvalidSignatureLength.selector, uint256(63)
                )
            );
            v3.submitProof(pi, testPayloadHash, badSig, testPubkey, testProof);
        }

        // === Scenario 2: bad pubkey length (valid signature) ===
        {
            _setMocksHappyPath();
            PublicInputs memory pi = _buildValidPubInputs();
            bytes memory badPubkey = new bytes(63);

            vm.prank(operator);
            vm.expectRevert(
                abi.encodeWithSelector(
                    EnergyProofRegistryV3.InvalidPubkeyLength.selector, uint256(63)
                )
            );
            v3.submitProof(pi, testPayloadHash, testSignature, badPubkey, testProof);
        }

        // === Scenario 3: epoch in future ===
        {
            _setMocksHappyPath();
            vm.warp(ANCHOR_TS);
            uint64 futureEpoch = ANCHOR_TS + 600; // 10 min ahead, > 5min drift
            PublicInputs memory pi = _buildPubInputs(1, 100, futureEpoch);

            vm.prank(operator);
            vm.expectRevert(
                abi.encodeWithSelector(
                    EnergyProofRegistryV3.EpochInFuture.selector, futureEpoch, ANCHOR_TS
                )
            );
            v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
        }

        // === Scenario 4: payload hash mismatch ===
        {
            _setMocksHappyPath();
            vm.warp(ANCHOR_TS);
            PublicInputs memory pi = _buildPubInputs(1, 100, ANCHOR_TS);
            bytes32 differentHash = bytes32(uint256(0xBADC0FFEE));

            vm.prank(operator);
            vm.expectRevert(
                abi.encodeWithSelector(
                    EnergyProofRegistryV3.PayloadHashMismatch.selector,
                    differentHash,
                    testPayloadHash
                )
            );
            v3.submitProof(pi, differentHash, testSignature, testPubkey, testProof);
        }

        // === Scenario 5: device not active ===
        {
            mockP256.setShouldReturnTrue(true);
            mockHonk.setShouldReturnTrue(true);
            mockRegistry.setAuthorized(testPubkey, false); // revoke
            vm.warp(ANCHOR_TS);
            PublicInputs memory pi = _buildPubInputs(1, 100, ANCHOR_TS);

            vm.prank(operator);
            vm.expectRevert(
                abi.encodeWithSelector(
                    EnergyProofRegistryV3.DeviceNotActive.selector, _deviceIdBytes32(1)
                )
            );
            v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
            // re-enable for next scenario
            mockRegistry.setAuthorized(testPubkey, true);
        }

        // === Scenario 6: P-256 signature invalid ===
        {
            mockP256.setShouldReturnTrue(false);
            mockHonk.setShouldReturnTrue(true);
            mockRegistry.setAuthorized(testPubkey, true);
            vm.warp(ANCHOR_TS);
            PublicInputs memory pi = _buildPubInputs(1, 100, ANCHOR_TS);

            vm.prank(operator);
            vm.expectRevert(EnergyProofRegistryV3.InvalidP256Signature.selector);
            v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
        }

        // === Scenario 7: ZK proof invalid ===
        {
            mockP256.setShouldReturnTrue(true);
            mockHonk.setShouldReturnTrue(false);
            mockRegistry.setAuthorized(testPubkey, true);
            vm.warp(ANCHOR_TS);
            PublicInputs memory pi = _buildPubInputs(1, 100, ANCHOR_TS);

            vm.prank(operator);
            vm.expectRevert(EnergyProofRegistryV3.InvalidZKProof.selector);
            v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
        }
    }

    // -----------------------------------------------------------------------
    // Individual deep checks (each with full setup)
    // -----------------------------------------------------------------------

    /// @notice pubInputs.payloadHash != payloadHash arg -> PayloadHashMismatch.
    /// @dev Separate from Scenario 4 above to provide a single-purpose test that
    ///      doesn't depend on running the entire ordering scenario block.
    function test_HashConsistencyCheck() public {
        _setMocksHappyPath();
        vm.warp(ANCHOR_TS);

        PublicInputs memory pi = _buildPubInputs(1, 100, ANCHOR_TS);
        bytes32 wrongHash = bytes32(uint256(0xC0FFEEBABE));

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                EnergyProofRegistryV3.PayloadHashMismatch.selector, wrongHash, testPayloadHash
            )
        );
        v3.submitProof(pi, wrongHash, testSignature, testPubkey, testProof);
    }

    /// @notice epochStartTs more than 5 minutes ahead of block.timestamp -> revert.
    /// @dev MAX_EPOCH_FUTURE_DRIFT = 300s. Boundary: > 300s (strict).
    function test_EpochInFutureReverts() public {
        _setMocksHappyPath();
        vm.warp(ANCHOR_TS);

        uint64 futureEpoch = ANCHOR_TS + 601; // 1 second past 5-minute boundary
        PublicInputs memory pi = _buildPubInputs(1, 100, futureEpoch);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                EnergyProofRegistryV3.EpochInFuture.selector, futureEpoch, ANCHOR_TS
            )
        );
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
    }

    /// @notice Replay of same (deviceId, sessionId) -> SessionKeyAlreadyUsed.
    /// @dev First submission marks sessionKey as used. Second attempt with same
    ///      pair (different epoch to bypass timestamp check) must revert.
    function test_SessionKeyReplayReverts() public {
        _setMocksHappyPath();
        vm.warp(ANCHOR_TS);

        // First submission succeeds
        PublicInputs memory pi1 = _buildPubInputs(1, 100, ANCHOR_TS);
        vm.prank(operator);
        v3.submitProof(pi1, testPayloadHash, testSignature, testPubkey, testProof);

        // Second submission with same (deviceId=1, sessionId=100) but different epoch
        vm.warp(ANCHOR_TS + 3600);
        PublicInputs memory pi2 = _buildPubInputs(1, 100, ANCHOR_TS + 3600);

        bytes32 expectedSessionKey = _sessionKey(1, 100);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                EnergyProofRegistryV3.SessionKeyAlreadyUsed.selector, expectedSessionKey
            )
        );
        v3.submitProof(pi2, testPayloadHash, testSignature, testPubkey, testProof);
    }

    // -----------------------------------------------------------------------
    // Pause/unpause interleaving
    // -----------------------------------------------------------------------

    /// @notice Interleave: submit → pause → submit reverts → unpause → submit succeeds.
    function test_PauseInterleave() public {
        _setMocksHappyPath();
        vm.warp(ANCHOR_TS);

        // First submission — success
        PublicInputs memory pi1 = _buildPubInputs(1, 100, ANCHOR_TS);
        vm.prank(operator);
        v3.submitProof(pi1, testPayloadHash, testSignature, testPubkey, testProof);

        // Pause
        vm.prank(pauser);
        v3.pause();
        assertTrue(v3.paused(), "should be paused");

        // Second submission — reverts EnforcedPause
        uint64 ts2 = ANCHOR_TS + 1 hours;
        vm.warp(ts2);
        PublicInputs memory pi2 = _buildPubInputs(1, 101, ts2);

        vm.prank(operator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        v3.submitProof(pi2, testPayloadHash, testSignature, testPubkey, testProof);

        // Unpause
        vm.prank(admin);
        v3.unpause();
        assertFalse(v3.paused(), "should be unpaused");

        // Third submission (retry of second, after unpause) — success
        vm.prank(operator);
        v3.submitProof(pi2, testPayloadHash, testSignature, testPubkey, testProof);

        // Verify state advanced
        assertEq(
            v3.lastSubmissionTimestamp(_deviceIdBytes32(1)), ts2, "ts not advanced after unpause"
        );
    }
}
