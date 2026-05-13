// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IDeviceRegistry} from "./interfaces/IDeviceRegistry.sol";

/// @title DeviceRegistry
/// @notice Authoritative registry of P-256 device public keys authorized to submit energy proofs.
/// @dev Non-upgradeable per V3_design.md v0.2 §18 Q4 default. Pubkey-based identity per §8.
///      Storage keyed by keccak256(pubkey) for O(1) authorization checks on the V3 hot path.
///      Coordinates stored internally for future use (V4+ geographic bounds), exposed via
///      getDeviceInfo() outside the IDeviceRegistry interface so V3 contract is unaffected.
///
///      Two-role model per V3_design.md v0.2 §18 Q-permissions:
///        - DEFAULT_ADMIN_ROLE — manages roles only (does NOT register devices by default)
///        - OPERATOR_ROLE — performs device lifecycle operations (register/revoke/reactivate/suspend)
contract DeviceRegistry is AccessControl, IDeviceRegistry {
    // ============================================================
    // Constants
    // ============================================================

    /// @notice Role permitted to register, revoke, reactivate, and suspend devices.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Expected length of an uncompressed P-256 public key (X || Y, 32 + 32 bytes).
    uint256 public constant P256_PUBKEY_LENGTH = 64;

    /// @notice Latitude bounds in E7 representation (-90.0 to +90.0 degrees).
    int32 public constant MIN_LAT_E7 = -900_000_000;
    int32 public constant MAX_LAT_E7 = 900_000_000;

    /// @notice Longitude bounds in E7 representation (-180.0 to +180.0 degrees).
    int32 public constant MIN_LON_E7 = -1_800_000_000;
    int32 public constant MAX_LON_E7 = 1_800_000_000;

    // ============================================================
    // Types
    // ============================================================

    /// @notice Lifecycle status of a registered device.
    /// @dev Unknown (0) is the default for never-registered pubkey hashes.
    ///      Active devices return true from isAuthorized; all others return false.
    enum DeviceStatus {
        Unknown,
        Active,
        Revoked,
        Suspended
    }

    /// @notice Per-device storage record.
    /// @dev Packed into a single storage slot (4 + 4 + 8 + 1 = 17 bytes, fits in 32).
    ///      Note that the pubkey itself is NOT stored — the mapping key (keccak256(pubkey))
    ///      uniquely identifies a device. This saves two slots per device.
    struct Device {
        int32 latE7;
        int32 lonE7;
        uint64 registeredAt;
        DeviceStatus status;
    }

    // ============================================================
    // State
    // ============================================================

    /// @dev Storage mapping from keccak256(pubkey) to per-device metadata.
    mapping(bytes32 pubKeyHash => Device) private _devices;

    /// @notice Total devices ever registered (Active + Revoked + Suspended).
    /// @dev Monotonic; never decreases. Useful for off-chain monitoring.
    uint256 public deviceCount;

    // ============================================================
    // Errors
    // ============================================================

    error ZeroAddress();
    error InvalidPubkeyLength(uint256 length);
    error InvalidCoordinates(int32 latE7, int32 lonE7);
    error DeviceAlreadyRegistered(bytes32 pubKeyHash);
    error DeviceNotFound(bytes32 pubKeyHash);
    error DeviceNotActive(bytes32 pubKeyHash);
    error DeviceAlreadyActive(bytes32 pubKeyHash);

    // ============================================================
    // Events
    // ============================================================

    event DeviceRegistered(
        bytes32 indexed pubKeyHash,
        int32 latE7,
        int32 lonE7,
        uint64 registeredAt,
        address indexed operator
    );
    event DeviceRevoked(bytes32 indexed pubKeyHash, address indexed operator);
    event DeviceReactivated(bytes32 indexed pubKeyHash, address indexed operator);
    event DeviceSuspended(bytes32 indexed pubKeyHash, address indexed operator);

    // ============================================================
    // Constructor
    // ============================================================

    /// @notice Initialize the registry with a single admin.
    /// @param admin Initial holder of DEFAULT_ADMIN_ROLE.
    /// @dev Admin does NOT automatically receive OPERATOR_ROLE — they must grant it
    ///      explicitly post-deployment if they want to perform device operations.
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ============================================================
    // IDeviceRegistry implementation
    // ============================================================

    /// @inheritdoc IDeviceRegistry
    /// @dev Hot path called by V3.submitProof on every submission.
    ///      Returns false (not revert) for invalid length to avoid breaking caller flow;
    ///      caller is expected to validate length independently.
    function isAuthorized(bytes calldata publicKey) external view override returns (bool) {
        if (publicKey.length != P256_PUBKEY_LENGTH) {
            return false;
        }
        bytes32 pubKeyHash = keccak256(publicKey);
        return _devices[pubKeyHash].status == DeviceStatus.Active;
    }

    // ============================================================
    // Operator functions — device lifecycle
    // ============================================================

    /// @notice Register a new device with its geographic location.
    /// @param publicKey Uncompressed P-256 public key (64 bytes: X || Y).
    /// @param latE7 Registered latitude in E7 representation.
    /// @param lonE7 Registered longitude in E7 representation.
    function registerDevice(
        bytes calldata publicKey,
        int32 latE7,
        int32 lonE7
    ) external onlyRole(OPERATOR_ROLE) {
        if (publicKey.length != P256_PUBKEY_LENGTH) {
            revert InvalidPubkeyLength(publicKey.length);
        }
        _validateCoordinates(latE7, lonE7);

        bytes32 pubKeyHash = keccak256(publicKey);
        if (_devices[pubKeyHash].status != DeviceStatus.Unknown) {
            revert DeviceAlreadyRegistered(pubKeyHash);
        }

        uint64 registeredAt = uint64(block.timestamp);
        _devices[pubKeyHash] = Device({
            latE7: latE7,
            lonE7: lonE7,
            registeredAt: registeredAt,
            status: DeviceStatus.Active
        });
        unchecked {
            ++deviceCount;
        }

        emit DeviceRegistered(pubKeyHash, latE7, lonE7, registeredAt, msg.sender);
    }

    /// @notice Permanently revoke an active device.
    /// @dev Revoked devices cannot be re-registered; reactivate them instead.
    function revokeDevice(bytes calldata publicKey) external onlyRole(OPERATOR_ROLE) {
        bytes32 pubKeyHash = keccak256(publicKey);
        Device storage device = _devices[pubKeyHash];

        if (device.status == DeviceStatus.Unknown) {
            revert DeviceNotFound(pubKeyHash);
        }
        if (device.status == DeviceStatus.Revoked) {
            revert DeviceNotActive(pubKeyHash);
        }

        device.status = DeviceStatus.Revoked;
        emit DeviceRevoked(pubKeyHash, msg.sender);
    }

    /// @notice Reactivate a previously revoked or suspended device.
    function reactivateDevice(bytes calldata publicKey) external onlyRole(OPERATOR_ROLE) {
        bytes32 pubKeyHash = keccak256(publicKey);
        Device storage device = _devices[pubKeyHash];

        if (device.status == DeviceStatus.Unknown) {
            revert DeviceNotFound(pubKeyHash);
        }
        if (device.status == DeviceStatus.Active) {
            revert DeviceAlreadyActive(pubKeyHash);
        }

        device.status = DeviceStatus.Active;
        emit DeviceReactivated(pubKeyHash, msg.sender);
    }

    /// @notice Temporarily suspend an active device.
    /// @dev Suspended devices return false from isAuthorized. Reactivate to restore.
    function suspendDevice(bytes calldata publicKey) external onlyRole(OPERATOR_ROLE) {
        bytes32 pubKeyHash = keccak256(publicKey);
        Device storage device = _devices[pubKeyHash];

        if (device.status != DeviceStatus.Active) {
            revert DeviceNotActive(pubKeyHash);
        }

        device.status = DeviceStatus.Suspended;
        emit DeviceSuspended(pubKeyHash, msg.sender);
    }

    // ============================================================
    // View functions (outside IDeviceRegistry)
    // ============================================================

    /// @notice Retrieve full metadata for a registered device.
    /// @return latE7 Registered latitude in E7 representation.
    /// @return lonE7 Registered longitude in E7 representation.
    /// @return registeredAt Timestamp when device was registered.
    /// @return status Current lifecycle status.
    function getDeviceInfo(bytes calldata publicKey)
        external
        view
        returns (int32 latE7, int32 lonE7, uint64 registeredAt, DeviceStatus status)
    {
        bytes32 pubKeyHash = keccak256(publicKey);
        Device memory device = _devices[pubKeyHash];
        return (device.latE7, device.lonE7, device.registeredAt, device.status);
    }

    /// @notice Return the current status of a device.
    function getDeviceStatus(bytes calldata publicKey)
        external
        view
        returns (DeviceStatus)
    {
        return _devices[keccak256(publicKey)].status;
    }

    // ============================================================
    // Internal helpers
    // ============================================================

    function _validateCoordinates(int32 latE7, int32 lonE7) internal pure {
        if (latE7 < MIN_LAT_E7 || latE7 > MAX_LAT_E7) {
            revert InvalidCoordinates(latE7, lonE7);
        }
        if (lonE7 < MIN_LON_E7 || lonE7 > MAX_LON_E7) {
            revert InvalidCoordinates(latE7, lonE7);
        }
    }
}
