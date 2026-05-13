// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import { V3TestBase } from "./V3TestBase.sol";
import { EnergyProofRegistryV3, PublicInputs } from "../src/EnergyProofRegistryV3.sol";
import { MockHonkVerifier } from "./mocks/MockHonkVerifier.sol";

/// @title V3_HonkVerifier
/// @notice HonkVerifier integration tests per docs/specs/V3_design.md §16.
/// @dev Two surfaces under test:
///        1. CHECK 4: UltraHonk ZK proof verify outcome routing.
///        2. setHonkVerifier(): admin-only setter with ZeroAddress revert + event emission.
///      Note: HonkVerifier is the LAST cryptographic check (after P-256). A test for
///      rejected proof requires both DeviceRegistry and P256Verifier to accept first,
///      otherwise the revert would come from an earlier check.
contract V3_HonkVerifier_Test is V3TestBase {
    // -----------------------------------------------------------------------
    // CHECK 4 (verify outcome routing)
    // -----------------------------------------------------------------------

    /// @notice MockHonkVerifier returns true -> submitProof succeeds.
    function test_ValidProofAccepted() public {
        // Arrange
        _setMocksHappyPath();

        // Act
        _submitWithDefaults();

        // Assert
        assertEq(
            v3.lastSubmissionTimestamp(_deviceIdBytes32(1)),
            uint64(block.timestamp),
            "submission state not written"
        );
    }

    /// @notice MockHonkVerifier returns false -> submitProof reverts InvalidZKProof.
    /// @dev Mocks earlier in the pipeline must accept, otherwise we'd hit a
    ///      different revert first.
    function test_Revert_InvalidProofReverts() public {
        // Arrange — P256 + DeviceRegistry happy, Honk rejects
        mockP256.setShouldReturnTrue(true);
        mockHonk.setShouldReturnTrue(false);
        mockRegistry.setAuthorized(testPubkey, true);

        // Act + Assert
        PublicInputs memory pi = _buildValidPubInputs();
        vm.prank(operator);
        vm.expectRevert(EnergyProofRegistryV3.InvalidZKProof.selector);
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
    }

    // -----------------------------------------------------------------------
    // setHonkVerifier — admin setter
    // -----------------------------------------------------------------------

    /// @notice Admin can swap the Honk verifier; new verifier's outcome governs.
    function test_SetHonkVerifierByAdmin() public {
        // Arrange — fresh mock that will reject
        MockHonkVerifier newHonk = new MockHonkVerifier();
        newHonk.setShouldReturnTrue(false);

        vm.prank(admin);
        v3.setHonkVerifier(address(newHonk));

        assertEq(v3.honkVerifier(), address(newHonk), "verifier pointer not updated");

        // Act + Assert — submit now uses newHonk which rejects
        mockP256.setShouldReturnTrue(true);
        // mockRegistry already authorizes testPubkey from setUp

        PublicInputs memory pi = _buildValidPubInputs();
        vm.prank(operator);
        vm.expectRevert(EnergyProofRegistryV3.InvalidZKProof.selector);
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
    }

    /// @notice setHonkVerifier(0) reverts ZeroAddress.
    function test_Revert_SetHonkVerifierToZero() public {
        vm.prank(admin);
        vm.expectRevert(EnergyProofRegistryV3.ZeroAddress.selector);
        v3.setHonkVerifier(address(0));
    }

    /// @notice setHonkVerifier(currentVerifier) reverts SameAddress.
    /// @dev Mirrors test_Revert_SetDeviceRegistryToSame for the Honk setter.
    function test_Revert_SetHonkVerifierToSame() public {
        vm.prank(admin);
        vm.expectRevert(EnergyProofRegistryV3.SameAddress.selector);
        v3.setHonkVerifier(address(mockHonk));
    }

    /// @notice HonkVerifierChanged event emits with correct old/new addresses.
    /// @dev Distinct from test_SetHonkVerifierByAdmin: that test verifies functional
    ///      change (rejecting new verifier blocks submitProof); this one verifies
    ///      strict event payload fidelity (both indexed args match).
    function test_SetHonkVerifierEventEmitted() public {
        // Arrange
        MockHonkVerifier newHonk = new MockHonkVerifier();

        // Expect event with both old and new verifier addresses (both indexed).
        // Flags: (topic1=true, topic2=true, topic3=false [n/a], data=false [no data]).
        vm.expectEmit(true, true, false, false, address(v3));
        emit EnergyProofRegistryV3.HonkVerifierChanged(address(mockHonk), address(newHonk));

        // Act
        vm.prank(admin);
        v3.setHonkVerifier(address(newHonk));
    }
}
