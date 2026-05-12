// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IHonkVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

/**
 * @title EnergyProofRegistry v06
 * @notice On-chain registry of ZK-verified energy attestations from InfraVeritas devices.
 * @dev Smart contract delegates ECDSA signature verification to the ZK circuit (Phase A.2.2)
 *      and only verifies the resulting proof against HonkVerifier here.
 */
contract EnergyProofRegistry {
    IHonkVerifier public immutable verifier;
    address public owner;

    /// @notice Time after last submission before isOnline() returns false (seconds)
    uint256 public constant ONLINE_TIMEOUT = 7200; // 2 hours

    struct ProofRecord {
        uint256 epochStartTs;
        int256 coarseLat;       // truncated GPS latitude (microdegrees / 10000)
        int256 coarseLon;       // truncated GPS longitude
        uint256 totalEnergyMwh; // computed by ZK circuit
        bytes32 proofHash;      // keccak256(proof) for indexing
        uint256 receivedAt;     // block.timestamp at acceptance
    }

    /// @notice deviceId => registered Ethereum address (Phase A; Phase B uses P-256 pubkey)
    mapping(uint256 => address) public deviceRegistry;

    /// @notice deviceId => array of all attestations
    mapping(uint256 => ProofRecord[]) public deviceHistory;

    /// @notice (deviceId, epochStartTs) => already submitted? (on-chain anti-replay)
    mapping(uint256 => mapping(uint256 => bool)) public usedEpochs;

    /// @notice deviceId => timestamp of last accepted proof
    mapping(uint256 => uint256) public lastEpochTimestamp;

    /// @notice running counter of all successful submissions across all devices
    uint256 public totalSubmissions;

    event DeviceRegistered(uint256 indexed deviceId, address indexed deviceAddress);
    event ProofVerified(
        uint256 indexed deviceId,
        uint256 epochStartTs,
        int256 coarseLat,
        int256 coarseLon,
        uint256 totalEnergyMwh,
        bytes32 indexed proofHash,
        uint256 receivedAt
    );

    constructor(address verifierAddress) {
        require(verifierAddress != address(0), "Invalid verifier");
        verifier = IHonkVerifier(verifierAddress);
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    /**
     * @notice Register a new device. Owner only.
     */
    function registerDevice(uint256 deviceId, address deviceAddress) external onlyOwner {
        require(deviceAddress != address(0), "Invalid device address");
        require(deviceRegistry[deviceId] == address(0), "Device already registered");
        deviceRegistry[deviceId] = deviceAddress;
        emit DeviceRegistered(deviceId, deviceAddress);
    }

    /**
     * @notice Submit a ZK proof of energy generation for a device epoch.
     * @dev publicInputs must have exactly 13 elements:
     *      [0] device_id, [1] epoch_start_ts, [2] coarse_lat, [3] coarse_lon,
     *      [4..11] UltraHonk system inputs, [12] total_energy_mwh.
     *      Phase A.2.1: trusts relayer to pass correct calldata args matching public inputs.
     *      Phase A.2.2: will add byte-level binding between public inputs and calldata args.
     */
    function submitProof(
        uint256 deviceId,
        uint256 epochStartTs,
        int256 coarseLat,
        int256 coarseLon,
        uint256 totalEnergyMwh,
        bytes calldata proof,
        bytes32[] calldata publicInputs
    ) external {
        require(deviceRegistry[deviceId] != address(0), "Device not registered");
        require(!usedEpochs[deviceId][epochStartTs], "Epoch already submitted");
        require(publicInputs.length > 0, "Empty public inputs");

        require(verifier.verify(proof, publicInputs), "Invalid proof");

        usedEpochs[deviceId][epochStartTs] = true;
        lastEpochTimestamp[deviceId] = block.timestamp;
        totalSubmissions++;

        bytes32 proofHash = keccak256(proof);

        deviceHistory[deviceId].push(ProofRecord({
            epochStartTs: epochStartTs,
            coarseLat: coarseLat,
            coarseLon: coarseLon,
            totalEnergyMwh: totalEnergyMwh,
            proofHash: proofHash,
            receivedAt: block.timestamp
        }));

        emit ProofVerified(
            deviceId, epochStartTs, coarseLat, coarseLon,
            totalEnergyMwh, proofHash, block.timestamp
        );
    }

    /**
     * @notice Returns true if device sent a proof within ONLINE_TIMEOUT seconds.
     */
    function isOnline(uint256 deviceId) external view returns (bool) {
        if (lastEpochTimestamp[deviceId] == 0) return false;
        return block.timestamp - lastEpochTimestamp[deviceId] < ONLINE_TIMEOUT;
    }

    /**
     * @notice Get the most recent proof record for a device.
     */
    function getLatestProof(uint256 deviceId) external view returns (ProofRecord memory) {
        uint256 count = deviceHistory[deviceId].length;
        require(count > 0, "No proofs for device");
        return deviceHistory[deviceId][count - 1];
    }

    /**
     * @notice Total number of attestations stored for a device.
     */
    function deviceProofCount(uint256 deviceId) external view returns (uint256) {
        return deviceHistory[deviceId].length;
    }

    /**
     * @notice Transfer ownership.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid new owner");
        owner = newOwner;
    }
}
