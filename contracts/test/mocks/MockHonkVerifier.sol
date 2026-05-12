// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IHonkVerifier} from "../../src/interfaces/IHonkVerifier.sol";

/// @title MockHonkVerifier
/// @notice Test-only controllable mock for IHonkVerifier.
/// @dev Returns `shouldReturnTrue` regardless of inputs. Toggle via setter from test setUp.
///      Used for L-006 and HonkVerifier wrapper integration tests per docs/specs/V3_design.md §16.
///      Real HonkVerifier is auto-generated from Noir circuit (Aztec Barretenberg).
contract MockHonkVerifier is IHonkVerifier {
    bool public shouldReturnTrue = true;

    /// @notice Set return value for next verify() calls.
    function setShouldReturnTrue(bool value) external {
        shouldReturnTrue = value;
    }

    /// @inheritdoc IHonkVerifier
    function verify(
        bytes calldata /* proof */,
        bytes32[] calldata /* publicInputs */
    ) external view returns (bool) {
        return shouldReturnTrue;
    }
}
