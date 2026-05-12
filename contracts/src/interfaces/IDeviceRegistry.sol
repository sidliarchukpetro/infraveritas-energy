// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @title IDeviceRegistry
/// @notice Interface for device authorization checks against the DeviceRegistry contract.
/// @dev Pubkey-based identity per docs/specs/V3_design.md v0.2 §8.
///      Uses raw public key bytes (64 bytes uncompressed P-256: X || Y) rather than
///      deviceId for authorization. Avoids duplicate lookups since pubkey is already
///      in submitProof parameters for P-256 signature verification.
///      Replaces deviceId-based pattern from v0.1 skeleton.
interface IDeviceRegistry {
    /// @notice Check if a device with given public key is authorized (registered and active).
    /// @param publicKey Uncompressed P-256 public key (64 bytes: X || Y).
    /// @return True if device is registered and active, false otherwise.
    function isAuthorized(bytes calldata publicKey) external view returns (bool);
}
