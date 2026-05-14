// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IP256Verifier} from "./interfaces/IP256Verifier.sol";

/// @title P256VerifierAdapter
/// @notice Adapts Daimo's raw-calldata P256 verifier to the IP256Verifier interface.
/// @dev Daimo's verifier (0xc2b78104907F722DABAc4C69f826a522B2754De4) is fallback-only:
///      expects 160 bytes raw calldata (hash || r || s || x || y) with NO function
///      selector. V3 calls IP256Verifier.verify(...) which prepends a selector,
///      breaking Daimo's decoding. This adapter strips the selector via abi.encodePacked
///      and forwards raw bytes to Daimo.
contract P256VerifierAdapter is IP256Verifier {
    address public immutable verifier;

    constructor(address _verifier) {
        require(_verifier != address(0), "ZeroAddress");
        verifier = _verifier;
    }

    /// @inheritdoc IP256Verifier
    function verify(
        bytes32 messageHash,
        bytes32 r,
        bytes32 s,
        bytes32 pubKeyX,
        bytes32 pubKeyY
    ) external view returns (bool) {
        (bool ok, bytes memory result) = verifier.staticcall(
            abi.encodePacked(messageHash, r, s, pubKeyX, pubKeyY)
        );
        return ok && result.length == 32 && uint256(bytes32(result)) == 1;
    }
}
