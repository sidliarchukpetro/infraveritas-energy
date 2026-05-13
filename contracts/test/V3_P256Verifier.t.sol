// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import { V3TestBase } from "./V3TestBase.sol";
import { EnergyProofRegistryV3, PublicInputs } from "../src/EnergyProofRegistryV3.sol";
import { MockP256Verifier } from "./mocks/MockP256Verifier.sol";

/// @title V3_P256Verifier
/// @notice L-006 P256Verifier integration tests per docs/specs/V3_design.md §16.
/// @dev Three surfaces under test:
///        1. CHECK 2: P-256 signature verify outcome routing (verifier returns bool).
///        2. setP256Verifier(): admin-only setter with ZeroAddress revert.
///        3. Length pre-checks: InvalidSignatureLength / InvalidPubkeyLength
///           (Phase 1 cheap checks per V3 lines 169-175; happen BEFORE verifier call).
///      Length checks ordering: signature.length is validated BEFORE devicePubkey.length.
///      A test for bad pubkey must therefore pass a VALID-length signature.
contract V3_P256Verifier_Test is V3TestBase {
    // -----------------------------------------------------------------------
    // CHECK 2 (verify outcome routing)
    // -----------------------------------------------------------------------

    /// @notice MockP256Verifier returns true -> submitProof succeeds.
    function test_ValidSignatureAccepted() public {
        // Arrange
        _setMocksHappyPath(); // mockP256.shouldReturnTrue = true

        // Act
        _submitWithDefaults();

        // Assert
        assertEq(
            v3.lastSubmissionTimestamp(_deviceIdBytes32(1)),
            uint64(block.timestamp),
            "submission state not written"
        );
    }

    /// @notice MockP256Verifier returns false -> submitProof reverts InvalidP256Signature.
    function test_Revert_InvalidSignatureReverts() public {
        // Arrange — set mock to reject
        mockP256.setShouldReturnTrue(false);
        mockHonk.setShouldReturnTrue(true);
        mockRegistry.setAuthorized(testPubkey, true);

        // Act + Assert
        PublicInputs memory pi = _buildValidPubInputs();
        vm.prank(operator);
        vm.expectRevert(EnergyProofRegistryV3.InvalidP256Signature.selector);
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
    }

    // -----------------------------------------------------------------------
    // setP256Verifier — admin setter
    // -----------------------------------------------------------------------

    /// @notice Admin can swap the P256 verifier; new verifier's outcome governs.
    /// @dev Deploy a second mock that rejects, swap it in, then verify submitProof reverts.
    function test_SetP256VerifierByAdmin() public {
        // Arrange — deploy a fresh mock that will reject
        MockP256Verifier newP256 = new MockP256Verifier();
        newP256.setShouldReturnTrue(false);

        vm.expectEmit(true, true, false, false, address(v3));
        emit EnergyProofRegistryV3.P256VerifierChanged(address(mockP256), address(newP256));

        vm.prank(admin);
        v3.setP256Verifier(address(newP256));

        assertEq(v3.p256Verifier(), address(newP256), "verifier pointer not updated");

        // Act + Assert — submit now uses newP256 which rejects
        mockHonk.setShouldReturnTrue(true);
        // mockRegistry already authorizes testPubkey from setUp

        PublicInputs memory pi = _buildValidPubInputs();
        vm.prank(operator);
        vm.expectRevert(EnergyProofRegistryV3.InvalidP256Signature.selector);
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
    }

    /// @notice setP256Verifier(0) reverts ZeroAddress.
    function test_Revert_SetP256VerifierToZero() public {
        vm.prank(admin);
        vm.expectRevert(EnergyProofRegistryV3.ZeroAddress.selector);
        v3.setP256Verifier(address(0));
    }

    /// @notice setP256Verifier(currentVerifier) reverts SameAddress.
    /// @dev Mirrors test_Revert_SetDeviceRegistryToSame for the P-256 setter.
    function test_Revert_SetP256VerifierToSame() public {
        vm.prank(admin);
        vm.expectRevert(EnergyProofRegistryV3.SameAddress.selector);
        v3.setP256Verifier(address(mockP256));
    }

    // -----------------------------------------------------------------------
    // Length pre-checks (Phase 1, before verifier call)
    // -----------------------------------------------------------------------

    /// @notice 63-byte signature -> revert InvalidSignatureLength(63).
    /// @dev Phase 1 cheap check — fails before any verifier call.
    function test_Revert_InvalidSignatureLength() public {
        // Arrange — 63-byte signature (off by one)
        bytes memory badSignature = new bytes(63);
        for (uint256 i = 0; i < 63; i++) {
            badSignature[i] = 0xCC;
        }

        _setMocksHappyPath();
        PublicInputs memory pi = _buildValidPubInputs();

        // Act + Assert
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                EnergyProofRegistryV3.InvalidSignatureLength.selector, uint256(63)
            )
        );
        v3.submitProof(pi, testPayloadHash, badSignature, testPubkey, testProof);
    }

    /// @notice 63-byte pubkey -> revert InvalidPubkeyLength(63).
    /// @dev Must use VALID-length signature, since signature.length is checked first.
    function test_Revert_InvalidPubkeyLength() public {
        // Arrange — valid signature, but 63-byte pubkey
        bytes memory badPubkey = new bytes(63);
        for (uint256 i = 0; i < 63; i++) {
            badPubkey[i] = 0xAA;
        }

        _setMocksHappyPath();
        PublicInputs memory pi = _buildValidPubInputs();

        // Act + Assert
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(EnergyProofRegistryV3.InvalidPubkeyLength.selector, uint256(63))
        );
        v3.submitProof(pi, testPayloadHash, testSignature, badPubkey, testProof);
    }
}
