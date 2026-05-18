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
///      Field order ALSO drives EIP-712 ENERGY_PROOF_TYPEHASH — keep in sync.
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
/// @dev UUPS upgradeable. See docs/specs/V3_design.md (v0.3) for architecture.
///      v0.3 adds EIP-712 typed signing: P-256 signatures are over a structured
///      digest binding (chainId, verifyingContract, struct fields), preventing
///      cross-chain, cross-contract, and cross-function replay.
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
    // EIP-712 typed signing constants (v0.3)
    // -------------------------------------------------------------------

    /// @dev EIP-712 domain typehash — standard format per EIP-712 specification.
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    /// @dev Typehash for EnergyProof struct. Field order MUST match PublicInputs struct exactly.
    ///      If PublicInputs struct fields change, this typehash MUST be regenerated.
    bytes32 private constant ENERGY_PROOF_TYPEHASH = keccak256(
        "EnergyProof(uint64 deviceId,uint64 sessionId,uint64 epochStartTs,int64 lat_e7,int64 lon_e7,uint64 lightLevel,uint64 tamperFlag,bytes32 payloadHash,uint64 totalEnergyMWh)"
    );

    /// @dev Pre-hashed domain name and version, saves gas vs re-hashing on each call.
    ///      Name deliberately omits version suffix ("V3") to remain stable across upgrades.
    bytes32 private constant DOMAIN_NAME_HASH = keccak256(bytes("InfraVeritas Energy"));
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256(bytes("1"));

    // -------------------------------------------------------------------
    // Storage (order matters for UUPS — see docs/specs/V3_design.md §12)
    // -------------------------------------------------------------------

    address public deviceRegistry;
    address public p256Verifier;
    address public honkVerifier;
    mapping(bytes32 deviceId => uint64 timestamp) public lastSubmissionTimestamp;
    mapping(bytes32 sessionKey => bool used) public usedSessionKeys;

    /// @dev Cached EIP-712 domain separator. Rebuilt lazily if chain forks (chainid changes).
    bytes32 private _cachedDomainSeparator;
    /// @dev Chain ID at the time _cachedDomainSeparator was computed.
    uint256 private _cachedChainId;

    /// @dev Reserved storage gap for future versions. Decrement when adding new state.
    ///      Originally [49]; decremented by 2 in v0.3 for _cachedDomainSeparator and _cachedChainId.
    // slither-disable-next-line unused-state
    uint256[47] private __gap;

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

    /// @notice Emitted when the EIP-712 domain separator is cached.
    /// @dev Fires on initialize and reinitializeEIP712.
    event DomainSeparatorCached(uint256 indexed chainId, bytes32 domainSeparator);

    // -------------------------------------------------------------------
    // Initializer
    // -------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the V3 proxy (fresh deployment path).
    /// @dev For existing proxies upgrading from pre-EIP-712 V3, use reinitializeEIP712 instead.
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

        // Cache EIP-712 domain separator at deployment chain.
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
        emit DomainSeparatorCached(block.chainid, _cachedDomainSeparator);
    }

    /// @notice Reinitialize EIP-712 cache after upgrading from a pre-EIP-712 V3 implementation.
    /// @dev Idempotent via reinitializer(2) — calling twice reverts.
    ///      Without calling this, the contract still works correctly (domainSeparator() lazy-rebuilds),
    ///      but each submitProof pays the rebuild gas cost. Call once after upgrade for gas savings.
    function reinitializeEIP712() external reinitializer(2) onlyRole(DEFAULT_ADMIN_ROLE) {
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
        emit DomainSeparatorCached(block.chainid, _cachedDomainSeparator);
    }

    // -------------------------------------------------------------------
    // EIP-712 helpers (v0.3)
    // -------------------------------------------------------------------

    /// @notice Returns the current EIP-712 domain separator.
    /// @dev Returns cached value if chainid matches; otherwise rebuilds (chain fork protection).
    ///      To persist a rebuild after a chain fork, governance must call reinitializeEIP712.
    function domainSeparator() public view returns (bytes32) {
        if (block.chainid == _cachedChainId) {
            return _cachedDomainSeparator;
        }
        return _buildDomainSeparator();
    }

    /// @notice Returns the EIP-712 digest for a given PublicInputs struct.
    /// @dev Off-chain signers MUST compute the same digest before signing.
    ///      Exposed externally to allow off-chain tools (edge firmware, sepolia_smoke.py)
    ///      to cross-check their digest computation against the on-chain canonical formula.
    function eip712Digest(PublicInputs calldata pubInputs) external view returns (bytes32) {
        return _eip712Digest(pubInputs);
    }

    /// @dev Build EIP-712 domain separator from current chain context.
    function _buildDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                DOMAIN_NAME_HASH,
                DOMAIN_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
    }

    /// @dev Compute EIP-712 struct hash for EnergyProof. Field order MUST match ENERGY_PROOF_TYPEHASH.
    function _structHash(PublicInputs calldata pi) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ENERGY_PROOF_TYPEHASH,
                pi.deviceId,
                pi.sessionId,
                pi.epochStartTs,
                pi.lat_e7,
                pi.lon_e7,
                pi.lightLevel,
                pi.tamperFlag,
                pi.payloadHash,
                pi.totalEnergyMWh
            )
        );
    }

    /// @dev Compute final EIP-712 digest: keccak256("\x19\x01" || domainSeparator || structHash).
    function _eip712Digest(PublicInputs calldata pi) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), _structHash(pi)));
    }

    // -------------------------------------------------------------------
    // Core: submitProof
    // 7 checks per docs/specs/V3_design.md v0.3 §11, ordered cheap to expensive.
    // v0.3 change: P-256 signature now verified against EIP-712 typed digest,
    // not raw payloadHash. This binds the signature to (chainId, verifyingContract,
    // typed struct fields) — blocks cross-chain, cross-contract, cross-function replay.
    // -------------------------------------------------------------------

    /// @notice Submit a verified energy proof from an edge device.
    /// @param pubInputs ZK proof public inputs (mirrors Noir circuit public outputs).
    /// @param payloadHash Poseidon hash of canonical payload; MUST equal pubInputs.payloadHash.
    /// @param signature ECDSA P-256 signature (64 bytes: r || s) over EIP-712 digest of pubInputs.
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
        // slither-disable-next-line timestamp
        if (pubInputs.epochStartTs > block.timestamp + MAX_EPOCH_FUTURE_DRIFT) {
            revert EpochInFuture(pubInputs.epochStartTs, uint64(block.timestamp));
        }

        // CHECK 3: Hash consistency — pubInputs.payloadHash mirrors what was committed in ZK circuit
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

        // CHECK 2: P-256 signature over EIP-712 typed digest (v0.3 change).
        // Edge device signs _eip712Digest(pubInputs), not raw payloadHash. Binding to
        // (chainId, verifyingContract, structured fields) prevents:
        //   - cross-chain replay (same payload+sig on Sepolia vs mainnet)
        //   - cross-contract replay (same payload+sig on V3 vs V4)
        //   - cross-function replay (same sig used for a different function)
        bytes32 digest = _eip712Digest(pubInputs);
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
        if (!IP256Verifier(p256Verifier).verify(digest, r, s, pubKeyX, pubKeyY)) {
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
