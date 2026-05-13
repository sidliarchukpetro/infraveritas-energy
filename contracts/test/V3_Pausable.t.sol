// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import { V3TestBase } from "./V3TestBase.sol";
import { EnergyProofRegistryV3, PublicInputs } from "../src/EnergyProofRegistryV3.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title V3_Pausable
/// @notice L-002 Pausable tests per docs/specs/V3_design.md §16.
/// @dev Verifies pause/unpause role gating + paused state blocks submitProof.
///      Asymmetric: pause = PAUSER_ROLE, unpause = DEFAULT_ADMIN_ROLE.
///      Note: V3 inherits PausableUpgradeable, but EnforcedPause selector is
///      identical between Pausable and PausableUpgradeable (no-arg error).
contract V3_Pausable_Test is V3TestBase {
    /// @notice After pause, submitProof reverts with EnforcedPause.
    function test_PauseBlocksSubmit() public {
        // Arrange
        _setMocksHappyPath();

        vm.prank(pauser);
        v3.pause();
        assertTrue(v3.paused(), "should be paused");

        // Act + Assert
        PublicInputs memory pi = _buildValidPubInputs();
        vm.prank(operator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
    }

    /// @notice After admin unpauses, submitProof works again.
    function test_UnpauseRestoresSubmit() public {
        // Arrange
        _setMocksHappyPath();

        vm.prank(pauser);
        v3.pause();
        assertTrue(v3.paused(), "should be paused first");

        vm.prank(admin);
        v3.unpause();
        assertFalse(v3.paused(), "should be unpaused");

        // Act
        _submitWithDefaults();

        // Assert
        bytes32 deviceIdB32 = _deviceIdBytes32(1);
        assertEq(
            v3.lastSubmissionTimestamp(deviceIdB32),
            uint64(block.timestamp),
            "submission should have succeeded"
        );
    }

    /// @notice Non-pauser (random caller) cannot call pause.
    function test_Revert_NonPauserCannotPause() public {
        // Arrange
        address notPauser = makeAddr("notPauser");

        // Act + Assert
        vm.prank(notPauser);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, notPauser, pauserRole
            )
        );
        v3.pause();
    }

    /// @notice Operator (no DEFAULT_ADMIN_ROLE) cannot unpause.
    /// @dev Distinct from test_Revert_PauserCannotUnpause in V3_AccessControl:
    ///      here operator (has OPERATOR_ROLE but not DEFAULT_ADMIN_ROLE) tries unpause.
    function test_Revert_NonAdminCannotUnpause() public {
        // Arrange — pause first as pauser
        vm.prank(pauser);
        v3.pause();

        // Act + Assert — operator tries unpause
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, operator, defaultAdminRole
            )
        );
        v3.unpause();
    }

    /// @notice Paused state does NOT block view functions (read-only access).
    /// @dev usedSessionKeys / lastSubmissionTimestamp / paused etc. are pure reads,
    ///      not subject to whenNotPaused modifier.
    function test_PausedDoesNotBlockViewFunctions() public {
        // Arrange — submit one valid proof, then pause
        _setMocksHappyPath();
        _submitWithDefaults();

        vm.prank(pauser);
        v3.pause();
        assertTrue(v3.paused(), "should be paused");

        // Act + Assert — view functions still readable
        bytes32 deviceIdB32 = _deviceIdBytes32(1);
        uint64 lastTs = v3.lastSubmissionTimestamp(deviceIdB32);
        bool sessionUsed = v3.usedSessionKeys(_sessionKey(1, 100));

        assertEq(lastTs, uint64(block.timestamp), "view of lastSubmissionTimestamp failed");
        assertTrue(sessionUsed, "view of usedSessionKeys failed");
        assertEq(v3.deviceRegistry(), address(mockRegistry), "view of deviceRegistry failed");
    }
}
