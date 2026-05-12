// SPDX-License-Identifier: UNLICENSED
// TODO: finalize license before public release (MIT / BUSL-1.1 / Apache-2.0)
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IDeviceRegistry} from "./interfaces/IDeviceRegistry.sol";
import {IP256Verifier} from "./interfaces/IP256Verifier.sol";

/// @title EnergyProofRegistryV3
/// @notice Records verified energy generation proofs from IoT edge devices.
/// @dev UUPS upgradeable. See docs/specs/V3_design.md for architecture.
contract EnergyProofRegistryV3 is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    // -------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    uint64 public constant MAX_GAP_SECONDS = 48 hours;

    // -------------------------------------------------------------------
    // Storage (order matters for UUPS — see docs/specs/V3_design.md §9)
    // -------------------------------------------------------------------

    address public deviceRegistry;
    address public p256Verifier;
    mapping(bytes32 deviceId => uint64 timestamp) public lastSubmissionTimestamp;
    mapping(bytes32 sessionKey => bool used) public usedSessionKeys;

    /// @dev Reserved storage gap for future versions. Decrement when adding new state.
    uint256[50] private __gap;

    // -------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------

    error DeviceNotActive(bytes32 deviceId);
    error InvalidTimestamp(uint64 provided, uint64 lastKnown);
    error SessionKeyAlreadyUsed(bytes32 sessionKey);
    error InvalidP256Signature();
    error InvalidZKProof();
    error ZeroAddress();
    error SameAddress();
    error NotImplemented();

    // -------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------

    event ProofSubmitted(
        bytes32 indexed deviceId,
        bytes32 indexed sessionKey,
        uint64 timestamp,
        uint64 gapFromPrevious,
        bool postDisconnection
    );

    event DeviceRegistryChanged(
        address indexed oldRegistry,
        address indexed newRegistry
    );

    event P256VerifierChanged(
        address indexed oldVerifier,
        address indexed newVerifier
    );

    // -------------------------------------------------------------------
    // Initializer
    // -------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the V3 proxy.
    /// @param admin Root admin (DEFAULT_ADMIN_ROLE, UPGRADER_ROLE).
    /// @param deviceRegistry_ Address of IDeviceRegistry implementation.
    /// @param p256Verifier_ Address of IP256Verifier implementation.
    function initialize(
        address admin,
        address deviceRegistry_,
        address p256Verifier_
    ) external initializer {
        if (admin == address(0)) revert ZeroAddress();
        if (deviceRegistry_ == address(0)) revert ZeroAddress();
        if (p256Verifier_ == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);

        deviceRegistry = deviceRegistry_;
        p256Verifier = p256Verifier_;
    }

    // -------------------------------------------------------------------
    // Core: submitProof (stub — body in week 4)
    // -------------------------------------------------------------------

    /// @notice Submit a verified energy proof. Body implemented in week 4.
    /// @dev TODO: finalize parameter list (proof bytes, sessionKey, deviceId,
    ///      timestamp, P-256 signature components).
    function submitProof()
        external
        whenNotPaused
        nonReentrant
        onlyRole(OPERATOR_ROLE)
    {
        revert NotImplemented();
    }

    // -------------------------------------------------------------------
    // Admin: pause / unpause
    // -------------------------------------------------------------------

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // -------------------------------------------------------------------
    // Admin: setters for DeviceRegistry and P256Verifier
    // -------------------------------------------------------------------

    function setDeviceRegistry(address newRegistry)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (newRegistry == address(0)) revert ZeroAddress();
        address old = deviceRegistry;
        if (newRegistry == old) revert SameAddress();
        deviceRegistry = newRegistry;
        emit DeviceRegistryChanged(old, newRegistry);
    }

    function setP256Verifier(address newVerifier)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (newVerifier == address(0)) revert ZeroAddress();
        address old = p256Verifier;
        if (newVerifier == old) revert SameAddress();
        p256Verifier = newVerifier;
        emit P256VerifierChanged(old, newVerifier);
    }

    // -------------------------------------------------------------------
    // UUPS upgrade authorization
    // -------------------------------------------------------------------

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(UPGRADER_ROLE)
    {}
}
