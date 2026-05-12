// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IP256Verifier} from "../../src/interfaces/IP256Verifier.sol";

/// @title MockP256Verifier
/// @notice Test-only controllable mock for IP256Verifier.
/// @dev Returns `shouldReturnTrue` regardless of inputs. Toggle via setter from test setUp.
///      Used for L-005 and P-256 signature integration tests per docs/specs/V3_design.md §16.
///      Real implementation: Daimo P256Verifier / FCL / EIP-7212 precompile (Etap 3).
contract MockP256Verifier is IP256Verifier {
    bool public shouldReturnTrue = true;

    /// @notice Set return value for next verify() calls.
    function setShouldReturnTrue(bool value) external {
        shouldReturnTrue = value;
    }

    /// @inheritdoc IP256Verifier
    function verify(
        bytes32 /* messageHash */,
        bytes32 /* r */,
        bytes32 /* s */,
        bytes32 /* pubKeyX */,
        bytes32 /* pubKeyY */
    ) external view returns (bool) {
        return shouldReturnTrue;
    }
}
