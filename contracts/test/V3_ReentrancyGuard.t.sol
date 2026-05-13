// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import { V3TestBase } from "./V3TestBase.sol";
import { EnergyProofRegistryV3, PublicInputs } from "../src/EnergyProofRegistryV3.sol";
import { MaliciousP256Verifier, MaliciousHonkVerifier } from "./mocks/MaliciousVerifier.sol";

/// @title V3_ReentrancyGuard
/// @notice L-003 Reentrancy protection tests per docs/specs/V3_design.md §16.
/// @dev Architectural note (see §18 Q8): all verifier interfaces are `view`, so
///      Solidity emits STATICCALL when calling them. EVM forbids state changes
///      inside STATICCALL nested calls — therefore a malicious verifier attempting
///      to re-enter submitProof() reverts at the EVM level (STATICCALL violation),
///      *before* the nonReentrant guard would even trigger.
///
///      We do NOT assert ReentrancyGuardReentrantCall selector — it would not fire
///      in this flow. Instead we assert that ANY revert occurs (vm.expectRevert()
///      without selector). This honestly tests that the protection holds.
///
///      nonReentrant remains as defense-in-depth: if a future verifier interface
///      is changed to non-view (state-mutating), the modifier becomes the active
///      defense layer. We do not test that path here.
contract V3_ReentrancyGuard_Test is V3TestBase {
    /// @notice Malicious P-256 verifier attempts re-entry — must revert.
    /// @dev Flow: swap verifier → arm attack → operator calls submitProof →
    ///      v3 STATICCALLs verify() → verify() attempts submitProof re-entry →
    ///      STATICCALL violation reverts inner call → outer submitProof reverts.
    function test_Revert_ReentrantCallRevertsViaP256() public {
        // Arrange — install malicious P-256 verifier
        MaliciousP256Verifier malP256 = new MaliciousP256Verifier();

        vm.prank(admin);
        v3.setP256Verifier(address(malP256));

        // Re-authorize device pubkey in registry (set in V3TestBase.setUp)
        // and ensure Honk verifier accepts.
        mockHonk.setShouldReturnTrue(true);

        PublicInputs memory pi = _buildValidPubInputs();

        // Arm the attack with same params operator will use
        malP256.armAttack(v3, pi, testPayloadHash, testSignature, testPubkey, testProof);

        // Act + Assert — any revert is acceptable per §18 Q8 rationale
        vm.prank(operator);
        vm.expectRevert();
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
    }

    /// @notice Malicious Honk verifier attempts re-entry — must revert.
    /// @dev Honk verify is called AFTER P-256 verify succeeds. This tests that
    ///      the protection holds at the later check point too.
    function test_Revert_ReentrantCallRevertsViaHonk() public {
        // Arrange — install malicious Honk verifier (keep P-256 mock = happy)
        MaliciousHonkVerifier malHonk = new MaliciousHonkVerifier();

        vm.prank(admin);
        v3.setHonkVerifier(address(malHonk));

        mockP256.setShouldReturnTrue(true);

        PublicInputs memory pi = _buildValidPubInputs();

        malHonk.armAttack(v3, pi, testPayloadHash, testSignature, testPubkey, testProof);

        // Act + Assert
        vm.prank(operator);
        vm.expectRevert();
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
    }
}
