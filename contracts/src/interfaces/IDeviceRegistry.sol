// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @title IDeviceRegistry
/// @notice Minimal interface used by EnergyProofRegistryV3.
/// @dev Full DeviceRegistry contract implemented separately.
interface IDeviceRegistry {
    function isActive(bytes32 deviceId) external view returns (bool);

    function getPublicKey(bytes32 deviceId) external view returns (bytes memory);
}
