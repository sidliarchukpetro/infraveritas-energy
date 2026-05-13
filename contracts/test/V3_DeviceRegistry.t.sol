// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import { V3TestBase } from "./V3TestBase.sol";
import { EnergyProofRegistryV3, PublicInputs } from "../src/EnergyProofRegistryV3.sol";
import { MockDeviceRegistry } from "./mocks/MockDeviceRegistry.sol";

/// @title V3_DeviceRegistry
/// @notice L-005 DeviceRegistry integration tests per docs/specs/V3_design.md §16.
/// @dev Two surfaces under test:
///        1. submitProof()'s CHECK 1: isAuthorized(devicePubkey) — auth gating.
///        2. setDeviceRegistry(): admin-only setter with ZeroAddress/SameAddress reverts.
///      Pubkey-based identity per V3_design.md §8: MockDeviceRegistry hashes the
///      raw 64-byte pubkey internally (keccak256). Test must pass identical bytes
///      to both setAuthorized() and submitProof().
contract V3_DeviceRegistry_Test is V3TestBase {
    // -----------------------------------------------------------------------
    // CHECK 1 (isAuthorized) — submitProof flow
    // -----------------------------------------------------------------------

    /// @notice Device authorized in MockDeviceRegistry can submit successfully.
    /// @dev Happy path — V3TestBase.setUp already authorizes testPubkey.
    function test_AuthorizedDeviceSubmits() public {
        // Arrange — already done in setUp; just ensure mocks are happy
        _setMocksHappyPath();

        // Act
        _submitWithDefaults();

        // Assert — state was written (proxy for successful submitProof)
        assertEq(
            v3.lastSubmissionTimestamp(_deviceIdBytes32(1)),
            uint64(block.timestamp),
            "submission state not written"
        );
    }

    /// @notice Deauthorized device (was authorized, then revoked) -> revert DeviceNotActive.
    function test_Revert_DeauthorizedDeviceReverts() public {
        // Arrange — revoke testPubkey
        mockP256.setShouldReturnTrue(true);
        mockHonk.setShouldReturnTrue(true);
        mockRegistry.setAuthorized(testPubkey, false);

        // Act + Assert
        PublicInputs memory pi = _buildValidPubInputs();
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                EnergyProofRegistryV3.DeviceNotActive.selector, _deviceIdBytes32(1)
            )
        );
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
    }

    /// @notice Never-registered device pubkey -> revert DeviceNotActive.
    /// @dev Distinct from test_Revert_DeauthorizedDeviceReverts: here the pubkey was
    ///      never seen by the registry, not revoked. Same revert is expected
    ///      because isAuthorized returns false for unknown keys (MockDeviceRegistry
    ///      uses default-false mapping).
    function test_Revert_NeverRegisteredDeviceReverts() public {
        // Arrange — make a brand new pubkey, never authorize it
        bytes memory neverRegisteredPubkey = abi.encodePacked(
            bytes32(0x1111111111111111111111111111111111111111111111111111111111111111),
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222)
        );

        _setMocksHappyPath();
        // Note: testPubkey is still authorized in setUp, but we'll pass neverRegisteredPubkey.

        PublicInputs memory pi = _buildValidPubInputs();

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                EnergyProofRegistryV3.DeviceNotActive.selector, _deviceIdBytes32(1)
            )
        );
        v3.submitProof(pi, testPayloadHash, testSignature, neverRegisteredPubkey, testProof);
    }

    // -----------------------------------------------------------------------
    // setDeviceRegistry — admin setter
    // -----------------------------------------------------------------------

    /// @notice Admin can swap the registry; new registry's authorization governs.
    /// @dev After swap, the old testPubkey authorization in mockRegistry is irrelevant.
    ///      New registry must authorize independently. We verify both:
    ///        - With new registry NOT authorizing testPubkey -> revert.
    ///        - With new registry authorizing testPubkey -> success.
    function test_SetDeviceRegistryByAdmin() public {
        // Arrange — deploy a fresh registry mock and swap it in
        MockDeviceRegistry newRegistry = new MockDeviceRegistry();

        vm.expectEmit(true, true, false, false, address(v3));
        emit EnergyProofRegistryV3.DeviceRegistryChanged(
            address(mockRegistry), address(newRegistry)
        );

        vm.prank(admin);
        v3.setDeviceRegistry(address(newRegistry));

        assertEq(v3.deviceRegistry(), address(newRegistry), "registry pointer not updated");

        // Act 1 — submit fails because newRegistry has no authorizations
        _setMocksHappyPath(); // mocks happy, but old mockRegistry irrelevant now
        PublicInputs memory pi = _buildValidPubInputs();
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                EnergyProofRegistryV3.DeviceNotActive.selector, _deviceIdBytes32(1)
            )
        );
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);

        // Act 2 — authorize in new registry, retry submit succeeds
        newRegistry.setAuthorized(testPubkey, true);
        // Use a NEW sessionId to avoid replay check from any partial state
        PublicInputs memory pi2 = _buildPubInputs(1, 101, uint64(block.timestamp));
        vm.prank(operator);
        v3.submitProof(pi2, testPayloadHash, testSignature, testPubkey, testProof);

        assertEq(
            v3.lastSubmissionTimestamp(_deviceIdBytes32(1)),
            uint64(block.timestamp),
            "submission via new registry failed"
        );
    }

    /// @notice setDeviceRegistry(0) reverts ZeroAddress.
    function test_Revert_SetDeviceRegistryToZero() public {
        vm.prank(admin);
        vm.expectRevert(EnergyProofRegistryV3.ZeroAddress.selector);
        v3.setDeviceRegistry(address(0));
    }

    /// @notice setDeviceRegistry(currentRegistry) reverts SameAddress.
    function test_Revert_SetDeviceRegistryToSame() public {
        vm.prank(admin);
        vm.expectRevert(EnergyProofRegistryV3.SameAddress.selector);
        v3.setDeviceRegistry(address(mockRegistry));
    }
}
