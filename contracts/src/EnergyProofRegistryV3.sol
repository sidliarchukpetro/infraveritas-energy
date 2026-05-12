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
///      Field order MUST match Noir circuit public output order — verify at v08 implementation.
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
/// @dev UUPS upgradeable. See docs/specs/V3_design.md (v0.2) for architecture.
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
    uint64 public constant MAX_EPOCH_FUTURE_DRIFT = 300; // 5 min tolerance for GPS/clock drift

    uint256 private constant P256_SIGNATURE_LENGTH = 64; // r (32) || s (32)
    uint256 private constant P256_PUBKEY_LENGTH = 64;    // X (32) || Y (32)
    uint256 private constant PUBLIC_INPUTS_COUNT = 9;    // mirrors PublicInputs struct fields

    // -------------------------------------------------------------------
    // Storage (order matters for UUPS — see docs/specs/V3_design.md §12)
    // -------------------------------------------------------------------

    address public deviceRegistry;
    address public p256Verifier;
    address public honkVerifier;
    mapping(bytes32 deviceId => uint64 timestamp) public lastSubmissionTimestamp;
    mapping(bytes32 sessionKey => bool used) public usedSessionKeys;

    /// @dev Reserved storage gap for future versions. Decrement when adding new state.
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
    error InvalidSignatureLength(uint256 length);
    error InvalidPubkeyLength(uint256 length);
    error ZeroAddress();
    error SameAddress();

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
    // 7 checks per docs/specs/V3_design.md v0.2 §11, ordered cheap to expensive.
    // -------------------------------------------------------------------

    /// @notice Submit a verified energy proof from an edge device.
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
        // === Phase 1: cheap state checks (fail fast on attacks/bugs) ===

        // Length validation for fixed-size bytes parameters
        if (signature.length != P256_SIGNATURE_LENGTH) {
            revert InvalidSignatureLength(signature.length);
        }
        if (devicePubkey.length != P256_PUBKEY_LENGTH) {
            revert InvalidPubkeyLength(devicePubkey.length);
        }

        // CHECK 6: Epoch sanity — epoch не далеко у майбутньому (GPS/clock drift tolerance)
        if (pubInputs.epochStartTs > block.timestamp + MAX_EPOCH_FUTURE_DRIFT) {
            revert EpochInFuture(pubInputs.epochStartTs, uint64(block.timestamp));
        }

        // CHECK 3: Hash consistency — pubInputs.payloadHash mirrors what was signed
        if (pubInputs.payloadHash != payloadHash) {
            revert PayloadHashMismatch(payloadHash, pubInputs.payloadHash);
        }

        // CHECK 5: Session unique — anti-replay protection
        bytes32 sessionKey = keccak256(
            abi.encodePacked(pubInputs.deviceId, pubInputs.sessionId)
        );
        if (usedSessionKeys[sessionKey]) {
            revert SessionKeyAlreadyUsed(sessionKey);
        }

        // CHECK 7a: Gap-checking pre-validation (compute only, no state writes yet)
        bytes32 deviceIdBytes32 = bytes32(uint256(pubInputs.deviceId));
        uint64 previousTimestamp = lastSubmissionTimestamp[deviceIdBytes32];
        uint64 gap = 0;
        bool postDisconnection = false;
        if (previousTimestamp != 0) {
            // Subsequent submission: enforce strict monotonic timestamp
            if (pubInputs.epochStartTs <= previousTimestamp) {
                revert InvalidTimestamp(pubInputs.epochStartTs, previousTimestamp);
            }
            gap = pubInputs.epochStartTs - previousTimestamp;
            postDisconnection = gap > MAX_GAP_SECONDS;
        }
        // First submission case: previousTimestamp == 0, gap == 0, postDisconnection == false

        // === Phase 2: external view call (low gas, before expensive crypto) ===

        // CHECK 1: Device authorized in DeviceRegistry
        if (!IDeviceRegistry(deviceRegistry).isAuthorized(devicePubkey)) {
            revert DeviceNotActive(deviceIdBytes32);
        }

        // === Phase 3: expensive crypto verification ===

        // CHECK 2: P-256 signature over payloadHash
        // Extract r, s, pubKeyX, pubKeyY from calldata bytes
        bytes32 r;
        bytes32 s;
        bytes32 pubKeyX;
        bytes32 pubKeyY;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            pubKeyX := calldataload(devicePubkey.offset)
            pubKeyY := calldataload(add(devicePubkey.offset, 32))
        }
        if (!IP256Verifier(p256Verifier).verify(payloadHash, r, s, pubKeyX, pubKeyY)) {
            revert InvalidP256Signature();
        }

        // CHECK 4: ZK proof valid
        bytes32[] memory pubInputsArray = _encodePublicInputs(pubInputs);
        if (!IHonkVerifier(honkVerifier).verify(proof, pubInputsArray)) {
            revert InvalidZKProof();
        }

        // === Phase 4: state writes (only after all 7 checks pass) ===

        usedSessionKeys[sessionKey] = true;
        lastSubmissionTimestamp[deviceIdBytes32] = pubInputs.epochStartTs;

        // === Phase 5: event emission ===

        emit ProofSubmitted(
            deviceIdBytes32,
            sessionKey,
            pubInputs.epochStartTs,
            gap,
            postDisconnection
        );
    }

    /// @notice Encode PublicInputs struct as bytes32[] for HonkVerifier.
    /// @dev Field order MUST match Noir circuit public output order.
    ///      For int64 fields (lat_e7, lon_e7): two's-complement preserved via int256 intermediate cast.
    ///      Verify alignment at v08 circuit design (Etap 3).
    function _encodePublicInputs(PublicInputs calldata pi)
        internal
        pure
        returns (bytes32[] memory)
    {
        bytes32[] memory inputs = new bytes32[](PUBLIC_INPUTS_COUNT);
        inputs[0] = bytes32(uint256(pi.deviceId));
        inputs[1] = bytes32(uint256(pi.sessionId));
        inputs[2] = bytes32(uint256(pi.epochStartTs));
        // int64 → int256 (sign-extend) → uint256 → bytes32 (preserves negative values)
        inputs[3] = bytes32(uint256(int256(pi.lat_e7)));
        inputs[4] = bytes32(uint256(int256(pi.lon_e7)));
        inputs[5] = bytes32(uint256(pi.lightLevel));
        inputs[6] = bytes32(uint256(pi.tamperFlag));
        inputs[7] = pi.payloadHash;
        inputs[8] = bytes32(uint256(pi.totalEnergyMWh));
        return inputs;
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
