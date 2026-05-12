// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IDeviceRegistry} from "../../src/interfaces/IDeviceRegistry.sol";

/// @title MockDeviceRegistry
/// @notice Test-only stateful mock for IDeviceRegistry.
/// @dev Maintains a mapping of authorized public keys (keyed by keccak256 of pubkey bytes).
///      Use `setAuthorized(pubkey, true)` from test setUp to register a device.
///      Used for L-005 DeviceRegistry integration tests per docs/specs/V3_design.md §16.
contract MockDeviceRegistry is IDeviceRegistry {
    mapping(bytes32 pubkeyHash => bool authorized) private _authorized;

    /// @notice Register or deregister a device pubkey for testing.
    /// @param publicKey Uncompressed P-256 public key (64 bytes: X || Y).
    /// @param value True to authorize, false to revoke.
    function setAuthorized(bytes calldata publicKey, bool value) external {
        _authorized[keccak256(publicKey)] = value;
    }

    /// @inheritdoc IDeviceRegistry
    function isAuthorized(bytes calldata publicKey) external view returns (bool) {
        return _authorized[keccak256(publicKey)];
    }
}
