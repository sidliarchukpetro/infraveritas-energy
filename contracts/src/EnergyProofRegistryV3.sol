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
import {IHonkVerifier} from "./interfaces/IHonkVerifier.sol";

/// @notice Public inputs to the ZK proof. Encoded as bytes32[] when passed to HonkVerifier.
/// @dev Mirror of Noir circuit public output structure (see v08 circuit design, Etap 3).
///      Hash function for payloadHash: Poseidon (BN254, parameters fixed at v08 design).
struct PublicInputs {
    uint64 deviceId;
    uint64 sessionId;
    uint64 epochStartTs;
    int64 lat_e7;
    int64 lon_e7;
    uint64 lightLevel;
    uint64 tamperFlag;
    bytes32 payloadHash;
    uint64 totalEnergyMWh;
}

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
    // Order: external contract addresses (grouped), then mappings, then __gap.
    // -------------------------------------------------------------------

    address public deviceRegistry;
    address public p256Verifier;
    address public honkVerifier;
    mapping(bytes32 deviceId => uint64 timestamp) public lastSubmissionTimestamp;
    mapping(bytes32 sessionKey => bool used) public usedSessionKeys;

    /// @dev Reserved storage gap for future versions. Decrement when adding new state.
    ///      Was uint256[50] in v0.1 skeleton; now uint256[49] after adding honkVerifier slot.
    uint256[49] private __gap;

    // -------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------

    error DeviceNotActive(bytes32 deviceId);
    error InvalidTimestamp(uint64 provided, uint64 lastKnown);
    error SessionKeyAlreadyUsed(bytes32 sessionKey);
    error InvalidP256Signature();
    error InvalidZKProof();
    error PayloadHashMismatch(bytes32 expected, bytes32 fromPubInputs);
    error EpochInFuture(uint64 epochTs, uint64 blockTs);
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

    event HonkVerifierChanged(
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
    /// @param honkVerifier_ Address of IHonkVerifier implementation (UltraHonk auto-generated).
    function initialize(
        address admin,
        address deviceRegistry_,
        address p256Verifier_,
        address honkVerifier_
    ) external initializer {
        if (admin == address(0)) revert ZeroAddress();
        if (deviceRegistry_ == address(0)) revert ZeroAddress();
        if (p256Verifier_ == address(0)) revert ZeroAddress();
        if (honkVerifier_ == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);

        deviceRegistry = deviceRegistry_;
        p256Verifier = p256Verifier_;
        honkVerifier = honkVerifier_;
    }

    // -------------------------------------------------------------------
    // Core: submitProof
    // Body implemented in week 4 per docs/specs/V3_design.md §6 + Architecture §submitProof.
    // Six checks: device authorized, signature valid, hash consistency, ZK valid,
    //             session unique, epoch sanity. Plus gap-checking (V3-specific).
    // -------------------------------------------------------------------

    /// @notice Submit a verified energy proof.
    /// @param pubInputs ZK proof public inputs (mirrors Noir circuit public outputs).
    /// @param payloadHash Poseidon hash of canonical payload, signed by edge.
    /// @param signature ECDSA P-256 signature (64 bytes: r || s) over payloadHash.
    /// @param devicePubkey Uncompressed P-256 public key (64 bytes: X || Y).
    /// @param proof UltraHonk ZK proof bytes.
    function submitProof(
        PublicInputs calldata pubInputs,
        bytes32 payloadHash,
        bytes calldata signature,
        bytes calldata devicePubkey,
        bytes calldata proof
    )
        external
        whenNotPaused
        nonReentrant
        onlyRole(OPERATOR_ROLE)
    {
        // Suppress unused-parameter warnings during skeleton phase.
        pubInputs; payloadHash; signature; devicePubkey; proof;
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
    // Admin: setters for DeviceRegistry, P256Verifier, HonkVerifier
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

    function setHonkVerifier(address newVerifier)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (newVerifier == address(0)) revert ZeroAddress();
        address old = honkVerifier;
        if (newVerifier == old) revert SameAddress();
        honkVerifier = newVerifier;
        emit HonkVerifierChanged(old, newVerifier);
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
