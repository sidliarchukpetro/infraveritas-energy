// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import { V3TestBase } from "./V3TestBase.sol";
import { EnergyProofRegistryV3, PublicInputs } from "../src/EnergyProofRegistryV3.sol";

/// @title V3_GapChecking
/// @notice L-004 Gap checking tests per docs/specs/V3_design.md §16.
/// @dev Tests the 48-hour MAX_GAP_SECONDS boundary with strict-greater-than semantics.
///
///      Contract semantics (verified from EnergyProofRegistryV3.sol lines 196-203):
///        gap = epochStartTs - previousTimestamp
///        postDisconnection = gap > MAX_GAP_SECONDS;   // STRICT greater than
///        if previousTimestamp == 0 -> gap=0, postDisconnection=false (first submission)
///        if epochStartTs <= previousTimestamp -> revert InvalidTimestamp
///
///      Therefore the 48-hour boundary is INCLUSIVE for "no disconnection":
///        gap == 48h -> postDisconnection = false
///        gap == 48h + 1s -> postDisconnection = true
contract V3_GapChecking_Test is V3TestBase {
    /// @dev Fixed anchor timestamp for deterministic time-based assertions.
    ///      ~ Sat Nov 14 2023 22:13:20 UTC.
    uint64 internal constant ANCHOR_TS = 1_700_000_000;

    // -----------------------------------------------------------------------
    // First-submission semantics
    // -----------------------------------------------------------------------

    /// @notice First submission for a device: gap=0, postDisconnection=false.
    function test_FirstSubmissionPostDisconnectionFalse() public {
        // Arrange
        _setMocksHappyPath();
        vm.warp(ANCHOR_TS);

        PublicInputs memory pi = _buildPubInputs(1, 100, ANCHOR_TS);
        bytes32 expectedSessionKey = _sessionKey(1, 100);
        bytes32 expectedDeviceB32 = _deviceIdBytes32(1);

        // Expect ProofSubmitted with gap=0, postDisconnection=false
        vm.expectEmit(true, true, false, true, address(v3));
        emit EnergyProofRegistryV3.ProofSubmitted(
            expectedDeviceB32,
            expectedSessionKey,
            ANCHOR_TS,
            0, // gap = 0
            false // postDisconnection = false
        );

        // Act
        vm.prank(operator);
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);

        // Assert — state written
        assertEq(v3.lastSubmissionTimestamp(expectedDeviceB32), ANCHOR_TS, "ts not stored");
    }

    // -----------------------------------------------------------------------
    // Gap < MAX_GAP (47h) -> flag false
    // -----------------------------------------------------------------------

    /// @notice Gap = 47h between submissions: flag remains false.
    function test_GapUnderMaxFlagFalse() public {
        // Arrange — first submission
        _setMocksHappyPath();
        vm.warp(ANCHOR_TS);
        _submitParameterized(1, 100, ANCHOR_TS);

        // Second submission 47h later
        uint64 gap = 47 hours;
        uint64 ts2 = ANCHOR_TS + gap;
        vm.warp(ts2);

        vm.expectEmit(true, true, false, true, address(v3));
        emit EnergyProofRegistryV3.ProofSubmitted(
            _deviceIdBytes32(1), _sessionKey(1, 101), ts2, gap, false
        );

        // Act
        _submitParameterized(1, 101, ts2);
    }

    // -----------------------------------------------------------------------
    // Gap == MAX_GAP (48h exactly) -> flag false (strict >)
    // -----------------------------------------------------------------------

    /// @notice Gap = exactly 48h: flag is FALSE (strict greater-than boundary).
    /// @dev Contract line: postDisconnection = gap > MAX_GAP_SECONDS;
    ///      48h > 48h == false -> flag false. Critical boundary.
    function test_GapExactlyMaxBoundaryFlagFalse() public {
        _setMocksHappyPath();
        vm.warp(ANCHOR_TS);
        _submitParameterized(1, 100, ANCHOR_TS);

        uint64 gap = 48 hours;
        uint64 ts2 = ANCHOR_TS + gap;
        vm.warp(ts2);

        vm.expectEmit(true, true, false, true, address(v3));
        emit EnergyProofRegistryV3.ProofSubmitted(
            _deviceIdBytes32(1),
            _sessionKey(1, 101),
            ts2,
            gap,
            false // <-- key assertion: 48h exact -> flag still FALSE
        );

        _submitParameterized(1, 101, ts2);
    }

    // -----------------------------------------------------------------------
    // Gap == MAX_GAP + 1s -> flag true
    // -----------------------------------------------------------------------

    /// @notice Gap = 48h + 1s: flag becomes true (just over boundary).
    function test_GapJustOverMaxFlagTrue() public {
        _setMocksHappyPath();
        vm.warp(ANCHOR_TS);
        _submitParameterized(1, 100, ANCHOR_TS);

        uint64 gap = 48 hours + 1;
        uint64 ts2 = ANCHOR_TS + gap;
        vm.warp(ts2);

        vm.expectEmit(true, true, false, true, address(v3));
        emit EnergyProofRegistryV3.ProofSubmitted(
            _deviceIdBytes32(1),
            _sessionKey(1, 101),
            ts2,
            gap,
            true // <-- flag flips to true at +1 second past boundary
        );

        _submitParameterized(1, 101, ts2);
    }

    // -----------------------------------------------------------------------
    // Gap much over MAX_GAP (7 days) -> flag true
    // -----------------------------------------------------------------------

    /// @notice Gap = 7 days: flag true.
    function test_GapMuchOverMaxFlagTrue() public {
        _setMocksHappyPath();
        vm.warp(ANCHOR_TS);
        _submitParameterized(1, 100, ANCHOR_TS);

        uint64 gap = 7 days;
        uint64 ts2 = ANCHOR_TS + gap;
        vm.warp(ts2);

        vm.expectEmit(true, true, false, true, address(v3));
        emit EnergyProofRegistryV3.ProofSubmitted(
            _deviceIdBytes32(1), _sessionKey(1, 101), ts2, gap, true
        );

        _submitParameterized(1, 101, ts2);
    }

    // -----------------------------------------------------------------------
    // Reverts on non-monotonic timestamps
    // -----------------------------------------------------------------------

    /// @notice Timestamp in the past relative to previous submission -> revert.
    function test_Revert_TimestampInPast() public {
        _setMocksHappyPath();
        vm.warp(ANCHOR_TS);
        _submitParameterized(1, 100, ANCHOR_TS);

        // Second submission with epochStartTs < ANCHOR_TS
        uint64 tsBack = ANCHOR_TS - 1;
        vm.warp(ANCHOR_TS + 1); // block.timestamp ahead, but pubInputs.epochStartTs back

        PublicInputs memory pi = _buildPubInputs(1, 101, tsBack);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                EnergyProofRegistryV3.InvalidTimestamp.selector, tsBack, ANCHOR_TS
            )
        );
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
    }

    /// @notice Timestamp equal to previous -> revert (strict monotonic).
    function test_Revert_TimestampEqual() public {
        _setMocksHappyPath();
        vm.warp(ANCHOR_TS);
        _submitParameterized(1, 100, ANCHOR_TS);

        // Second submission with same epochStartTs (different sessionId, so replay
        // check doesn't trigger first; gap check must trigger).
        vm.warp(ANCHOR_TS + 1);
        PublicInputs memory pi = _buildPubInputs(1, 101, ANCHOR_TS);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                EnergyProofRegistryV3.InvalidTimestamp.selector, ANCHOR_TS, ANCHOR_TS
            )
        );
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
    }

    // -----------------------------------------------------------------------
    // Independence between devices
    // -----------------------------------------------------------------------

    /// @notice Different devices have independent gap state.
    /// @dev Device 1 first submission at ANCHOR_TS. Device 2 first submission
    ///      also at ANCHOR_TS — must succeed with postDisconnection=false
    ///      because device 2 has no previousTimestamp.
    function test_MultipleDevicesIndependent() public {
        _setMocksHappyPath();
        vm.warp(ANCHOR_TS);

        // Device 1 first submission
        _submitParameterized(1, 100, ANCHOR_TS);
        assertEq(v3.lastSubmissionTimestamp(_deviceIdBytes32(1)), ANCHOR_TS, "device 1 ts wrong");

        // Device 2 first submission at same block.timestamp — should be first-submission
        vm.expectEmit(true, true, false, true, address(v3));
        emit EnergyProofRegistryV3.ProofSubmitted(
            _deviceIdBytes32(2), _sessionKey(2, 200), ANCHOR_TS, 0, false
        );
        _submitParameterized(2, 200, ANCHOR_TS);

        // Assert separate state
        assertEq(v3.lastSubmissionTimestamp(_deviceIdBytes32(2)), ANCHOR_TS, "device 2 ts wrong");
        assertEq(v3.lastSubmissionTimestamp(_deviceIdBytes32(1)), ANCHOR_TS, "device 1 ts changed");
    }

    // -----------------------------------------------------------------------
    // Event payload fidelity
    // -----------------------------------------------------------------------

    /// @notice Event fields exactly match contract gap calculation for arbitrary gap.
    /// @dev Uses an off-round gap (50 hours = 180000 seconds) to defend against
    ///      hardcoded constants matching by accident.
    function test_EventFieldsMatchCalculation() public {
        _setMocksHappyPath();
        vm.warp(ANCHOR_TS);
        _submitParameterized(1, 100, ANCHOR_TS);

        uint64 gap = 50 hours; // 180_000 seconds
        uint64 ts2 = ANCHOR_TS + gap;
        vm.warp(ts2);

        vm.expectEmit(true, true, false, true, address(v3));
        emit EnergyProofRegistryV3.ProofSubmitted(
            _deviceIdBytes32(1), _sessionKey(1, 101), ts2, gap, true
        );

        _submitParameterized(1, 101, ts2);
    }

    // -----------------------------------------------------------------------
    // Internal helper — parameterized submit
    // -----------------------------------------------------------------------

    function _submitParameterized(uint64 deviceId, uint64 sessionId, uint64 epochStartTs) internal {
        PublicInputs memory pi = _buildPubInputs(deviceId, sessionId, epochStartTs);
        vm.prank(operator);
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
    }
}
