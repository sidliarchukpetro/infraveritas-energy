// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import { IP256Verifier } from "../../src/interfaces/IP256Verifier.sol";
import { IHonkVerifier } from "../../src/interfaces/IHonkVerifier.sol";
import { EnergyProofRegistryV3, PublicInputs } from "../../src/EnergyProofRegistryV3.sol";

/// @title MaliciousP256Verifier
/// @notice Test-only mock that attempts to re-enter EnergyProofRegistryV3.submitProof()
///         during its own verify() call.
/// @dev Implements IP256Verifier. When verify() is called, attempts to call back
///      into v3.submitProof() with crafted attack payload.
///      Since IP256Verifier.verify is `view`, Solidity emits STATICCALL — any state
///      mutation inside the attempted re-entry will revert at EVM level.
///      This mock therefore demonstrates that L-003 protection holds even if
///      a hostile contract is installed as the P-256 verifier.
contract MaliciousP256Verifier is IP256Verifier {
    EnergyProofRegistryV3 public target;
    PublicInputs public attackInputs;
    bytes32 public attackPayloadHash;
    bytes public attackSignature;
    bytes public attackPubkey;
    bytes public attackProof;
    bool public attackArmed;

    /// @notice Configure the re-entrancy attack payload.
    /// @dev Called from test setUp before triggering submitProof.
    function armAttack(
        EnergyProofRegistryV3 target_,
        PublicInputs memory pubInputs_,
        bytes32 payloadHash_,
        bytes memory signature_,
        bytes memory devicePubkey_,
        bytes memory proof_
    ) external {
        target = target_;
        attackInputs = pubInputs_;
        attackPayloadHash = payloadHash_;
        attackSignature = signature_;
        attackPubkey = devicePubkey_;
        attackProof = proof_;
        attackArmed = true;
    }

    /// @inheritdoc IP256Verifier
    /// @dev Declared `view` per interface — Solidity emits STATICCALL when v3
    ///      calls this. The attempted submitProof re-entry below will trigger
    ///      a STATICCALL violation (since submitProof writes state), reverting
    ///      the entire outer submitProof call. This is the test goal.
    function verify(
        bytes32,
        /* messageHash */
        bytes32,
        /* r */
        bytes32,
        /* s */
        bytes32,
        /* pubKeyX */
        bytes32 /* pubKeyY */
    )
        external
        view
        returns (bool)
    {
        if (attackArmed) {
            // Attempted re-entry using low-level staticcall.
            //
            // Why staticcall and not high-level target.submitProof(...):
            //   Solidity 0.8.x rejects high-level calls to non-view functions
            //   from within a view function at COMPILE time, even if the runtime
            //   would have rejected them anyway. Low-level staticcall is the only
            //   way to attempt the call in a view context.
            //
            // What we test:
            //   The inner submitProof writes state (e.g. usedSessionKeys[...] = true).
            //   EVM STATICCALL forbids SSTORE in any nested frame, so the inner call
            //   reverts at the first write. We bubble that revert so the outer
            //   submitProof (which triggered this verify) also reverts. ANY revert
            //   is acceptable for the L-003 test — see V3_design.md §18 Q8.
            (bool ok, bytes memory ret) = address(target)
                .staticcall(
                    abi.encodeWithSelector(
                        EnergyProofRegistryV3.submitProof.selector,
                        attackInputs,
                        attackPayloadHash,
                        attackSignature,
                        attackPubkey,
                        attackProof
                    )
                );
            if (!ok) {
                // Bubble inner revert reason if present, else just revert empty.
                if (ret.length > 0) {
                    assembly ("memory-safe") {
                        revert(add(ret, 0x20), mload(ret))
                    }
                }
                revert();
            }
        }
        return true; // unreachable if attack armed; reached if test disarms
    }
}

/// @title MaliciousHonkVerifier
/// @notice Same re-entry attempt, but installed as the HonkVerifier instead.
/// @dev Order in submitProof: P-256 → Honk. So HonkVerifier-based attack tests
///      that the protection holds even AFTER P-256 already passed.
contract MaliciousHonkVerifier is IHonkVerifier {
    EnergyProofRegistryV3 public target;
    PublicInputs public attackInputs;
    bytes32 public attackPayloadHash;
    bytes public attackSignature;
    bytes public attackPubkey;
    bytes public attackProof;
    bool public attackArmed;

    function armAttack(
        EnergyProofRegistryV3 target_,
        PublicInputs memory pubInputs_,
        bytes32 payloadHash_,
        bytes memory signature_,
        bytes memory devicePubkey_,
        bytes memory proof_
    ) external {
        target = target_;
        attackInputs = pubInputs_;
        attackPayloadHash = payloadHash_;
        attackSignature = signature_;
        attackPubkey = devicePubkey_;
        attackProof = proof_;
        attackArmed = true;
    }

    /// @inheritdoc IHonkVerifier
    /// @dev See MaliciousP256Verifier.verify for STATICCALL rationale.
    function verify(
        bytes calldata,
        /* proof */
        bytes32[] calldata /* publicInputs */
    )
        external
        view
        returns (bool)
    {
        if (attackArmed) {
            // See MaliciousP256Verifier.verify for rationale.
            (bool ok, bytes memory ret) = address(target)
                .staticcall(
                    abi.encodeWithSelector(
                        EnergyProofRegistryV3.submitProof.selector,
                        attackInputs,
                        attackPayloadHash,
                        attackSignature,
                        attackPubkey,
                        attackProof
                    )
                );
            if (!ok) {
                if (ret.length > 0) {
                    assembly ("memory-safe") {
                        revert(add(ret, 0x20), mload(ret))
                    }
                }
                revert();
            }
        }
        return true;
    }
}
