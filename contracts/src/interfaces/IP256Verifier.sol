// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @title IP256Verifier
/// @notice Wrapper interface for secp256r1 (P-256) signature verification.
/// @dev Implementation choice (Daimo / FCL / EIP-7212 precompile) deferred to Etap 3.
interface IP256Verifier {
    function verify(
        bytes32 messageHash,
        bytes32 r,
        bytes32 s,
        bytes32 pubKeyX,
        bytes32 pubKeyY
    ) external view returns (bool);
}
