// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import { EnergyProofRegistryV3 } from "../src/EnergyProofRegistryV3.sol";
import { PublicInputs } from "../src/EnergyProofRegistryV3.sol";
import { MockDeviceRegistry } from "./mocks/MockDeviceRegistry.sol";
import { MockP256Verifier } from "./mocks/MockP256Verifier.sol";
import { MockHonkVerifier } from "./mocks/MockHonkVerifier.sol";

/// @notice Abstract base for all EnergyProofRegistryV3 test contracts.
/// @dev Deploy sequence: impl → ERC1967Proxy(impl, initData) → cast to V3.
///      All child test contracts inherit this setUp and shared helpers.
abstract contract V3TestBase is Test {
    // -----------------------------------------------------------------------
    // Deployed contracts
    // -----------------------------------------------------------------------

    EnergyProofRegistryV3 internal v3;
    MockDeviceRegistry internal mockRegistry;
    MockP256Verifier internal mockP256;
    MockHonkVerifier internal mockHonk;

    // -----------------------------------------------------------------------
    // Test actors
    // -----------------------------------------------------------------------

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal pauser = makeAddr("pauser");

    // -----------------------------------------------------------------------
    // Cached role identifiers (populated in setUp).
    // -----------------------------------------------------------------------
    //
    // NOTE: Reading v3.OPERATOR_ROLE() inline inside vm.expectRevert(...) args
    // or before grantRole(...) is an external view call that consumes any
    // active vm.prank. Caching once after deploy avoids the gotcha.
    bytes32 internal operatorRole;
    bytes32 internal pauserRole;
    bytes32 internal upgraderRole;
    bytes32 internal defaultAdminRole;

    // -----------------------------------------------------------------------
    // Test device data
    // 64-byte uncompressed P-256 pubkey (X || Y). Same bytes that go into
    // submitProof as devicePubkey, and into setAuthorized() in MockDeviceRegistry.
    // -----------------------------------------------------------------------

    bytes internal testPubkey = abi.encodePacked(
        bytes32(0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA),
        bytes32(0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB)
    );

    // 64-byte dummy P-256 signature (r || s) — accepted by MockP256Verifier regardless
    bytes internal testSignature = abi.encodePacked(
        bytes32(0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC),
        bytes32(0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD)
    );

    // Dummy ZK proof bytes — accepted by MockHonkVerifier regardless
    bytes internal testProof = abi.encodePacked(
        bytes32(0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE)
    );

    // payloadHash used in happy-path tests
    bytes32 internal testPayloadHash = bytes32(uint256(0xDEADBEEF));

    // -----------------------------------------------------------------------
    // setUp — called before each test in child contracts
    // -----------------------------------------------------------------------

    function setUp() public virtual {
        // 1. Deploy mocks
        mockRegistry = new MockDeviceRegistry();
        mockP256 = new MockP256Verifier();
        mockHonk = new MockHonkVerifier();

        // 2. Deploy V3 implementation (constructors calls _disableInitializers)
        EnergyProofRegistryV3 impl = new EnergyProofRegistryV3();

        // 3. Encode initializer call
        bytes memory initData = abi.encodeCall(
            EnergyProofRegistryV3.initialize,
            (admin, address(mockRegistry), address(mockP256), address(mockHonk))
        );

        // 4. Deploy ERC1967 proxy — this calls initialize()
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        v3 = EnergyProofRegistryV3(address(proxy));

        // 4b. Cache role identifiers — single external read each, never
        //     repeated inside test bodies (avoids vm.prank consumption gotcha).
        operatorRole = v3.OPERATOR_ROLE();
        pauserRole = v3.PAUSER_ROLE();
        upgraderRole = v3.UPGRADER_ROLE();
        defaultAdminRole = v3.DEFAULT_ADMIN_ROLE();

        // 5+6. Grant OPERATOR_ROLE to operator and PAUSER_ROLE to pauser.
        //      initialize() grants only DEFAULT_ADMIN_ROLE + UPGRADER_ROLE to admin.
        //      NOTE: vm.prank consumes for ONE external call. v3.OPERATOR_ROLE() is itself
        //      an external view call that consumes the prank, so we use startPrank/stopPrank
        //      to keep msg.sender = admin across the role-id read + grantRole call.
        vm.startPrank(admin);
        v3.grantRole(operatorRole, operator);
        v3.grantRole(pauserRole, pauser);
        vm.stopPrank();

        // 7. Authorize testPubkey in MockDeviceRegistry
        //    Same bytes that will be passed as devicePubkey in submitProof.
        mockRegistry.setAuthorized(testPubkey, true);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /// @notice Build a valid PublicInputs struct for happy-path tests.
    /// @dev payloadHash matches testPayloadHash — both must be identical for
    ///      CHECK 3 (PayloadHashMismatch) to pass.
    function _buildValidPubInputs() internal view returns (PublicInputs memory) {
        return PublicInputs({
            deviceId: 1,
            sessionId: 100,
            epochStartTs: uint64(block.timestamp),
            lat_e7: 480000000, // 48.0000 N
            lon_e7: 250000000, // 25.0000 E
            lightLevel: 50000,
            tamperFlag: 0,
            payloadHash: testPayloadHash,
            totalEnergyMWh: 1000
        });
    }

    /// @notice Build a PublicInputs struct with custom deviceId, sessionId, epochStartTs.
    /// @dev Used for L-004 gap-checking and multi-submission tests where each call
    ///      needs distinct (deviceId, sessionId) to avoid the replay check, and
    ///      controlled epochStartTs to test 48h boundary cases.
    function _buildPubInputs(uint64 deviceId, uint64 sessionId, uint64 epochStartTs)
        internal
        view
        returns (PublicInputs memory)
    {
        return PublicInputs({
            deviceId: deviceId,
            sessionId: sessionId,
            epochStartTs: epochStartTs,
            lat_e7: 480000000,
            lon_e7: 250000000,
            lightLevel: 50000,
            tamperFlag: 0,
            payloadHash: testPayloadHash,
            totalEnergyMWh: 1000
        });
    }

    /// @notice Set all mocks to happy-path (return true) and device authorized.
    function _setMocksHappyPath() internal {
        mockP256.setShouldReturnTrue(true);
        mockHonk.setShouldReturnTrue(true);
        mockRegistry.setAuthorized(testPubkey, true);
    }

    /// @notice Call submitProof with all valid defaults as operator.
    /// @dev Uses testPubkey, testSignature, testProof, testPayloadHash.
    function _submitWithDefaults() internal {
        PublicInputs memory pi = _buildValidPubInputs();
        vm.prank(operator);
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
    }

    /// @notice Compute deviceIdBytes32 the same way the contract does.
    /// @dev bytes32(uint256(pubInputs.deviceId)) — used for lastSubmissionTimestamp key.
    function _deviceIdBytes32(uint64 deviceId) internal pure returns (bytes32) {
        return bytes32(uint256(deviceId));
    }

    /// @notice Compute sessionKey the same way the contract does.
    function _sessionKey(uint64 deviceId, uint64 sessionId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(deviceId, sessionId));
    }
}
