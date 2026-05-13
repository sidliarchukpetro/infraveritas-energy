// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {EnergyProofRegistryV3, PublicInputs} from "../src/EnergyProofRegistryV3.sol";
import {DeviceRegistry} from "../src/DeviceRegistry.sol";
import {MockP256Verifier} from "./mocks/MockP256Verifier.sol";
import {MockHonkVerifier} from "./mocks/MockHonkVerifier.sol";

/// @title V3 + DeviceRegistry integration tests
/// @notice Tests that wire a real DeviceRegistry into V3 (verifiers remain mocked).
/// @dev These tests complement:
///      - DeviceRegistry.t.sol (DeviceRegistry unit tests, 24 tests)
///      - Future V3 unit tests by Taras with mocked dependencies (L-001..L-006)
///
///      Focus here: validate the V3-to-DeviceRegistry wire-up works as designed.
///      P256Verifier and HonkVerifier remain mocked because their real implementations
///      require cryptographically valid signatures and ZK proofs which we cannot generate
///      in pure Foundry tests.
contract V3WithDeviceRegistryTest is Test {
    EnergyProofRegistryV3 internal v3;
    DeviceRegistry internal registry;
    MockP256Verifier internal p256;
    MockHonkVerifier internal honk;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal attacker = makeAddr("attacker");

    bytes internal validPubkey;
    bytes internal otherPubkey;

    int32 internal constant SAMPLE_LAT_E7 = 484_500_000;  // ~48.45° Sniatyn (registry int32)
    int32 internal constant SAMPLE_LON_E7 = 255_500_000;  // ~25.55°

    uint64 internal constant SAMPLE_DEVICE_ID = 1001;
    uint64 internal constant SAMPLE_SESSION_ID = 1;

    function setUp() public {
        // Realistic May 2026 timestamp (matches today's calendar context, avoids issues with
        // default block.timestamp == 1 which would underflow epochTs - prev in some scenarios)
        vm.warp(1_778_000_000);

        // 64-byte sample pubkeys (X || Y); content arbitrary for tests since P-256 is mocked
        validPubkey = new bytes(64);
        otherPubkey = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            validPubkey[i] = bytes1(uint8(i + 1));
            otherPubkey[i] = bytes1(uint8(255 - i));
        }

        // --- DeviceRegistry deployment ---
        registry = new DeviceRegistry(admin);

        bytes32 registryOperatorRole = registry.OPERATOR_ROLE();
        vm.prank(admin);
        registry.grantRole(registryOperatorRole, operator);

        vm.prank(operator);
        registry.registerDevice(validPubkey, SAMPLE_LAT_E7, SAMPLE_LON_E7);

        // --- Mock verifiers (default both return true) ---
        p256 = new MockP256Verifier();
        honk = new MockHonkVerifier();

        // --- V3 deployment via UUPS proxy ---
        EnergyProofRegistryV3 implementation = new EnergyProofRegistryV3();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(
                EnergyProofRegistryV3.initialize,
                (admin, address(registry), address(p256), address(honk))
            )
        );
        v3 = EnergyProofRegistryV3(address(proxy));

        // Grant operator V3.OPERATOR_ROLE (admin does NOT auto-receive it)
        bytes32 v3OperatorRole = v3.OPERATOR_ROLE();
        vm.prank(admin);
        v3.grantRole(v3OperatorRole, operator);
    }

    // ============================================================
    // Wire-up sanity
    // ============================================================

    function test_Init_DeviceRegistryAddressStored() public view {
        assertEq(v3.deviceRegistry(), address(registry));
    }

    function test_Init_AdminHasAdminRole() public view {
        assertTrue(v3.hasRole(v3.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(v3.hasRole(v3.UPGRADER_ROLE(), admin));
    }

    // ============================================================
    // Happy path
    // ============================================================

    function test_SubmitProof_SuccessWithAuthorizedDevice() public {
        uint64 epochTs = uint64(block.timestamp);
        (
            PublicInputs memory pubInputs,
            bytes32 payloadHash,
            bytes memory signature,
            bytes memory proof
        ) = _buildSubmission(SAMPLE_DEVICE_ID, SAMPLE_SESSION_ID, epochTs);

        bytes32 expectedSessionKey =
            keccak256(abi.encodePacked(SAMPLE_DEVICE_ID, SAMPLE_SESSION_ID));
        bytes32 expectedDeviceIdBytes32 = bytes32(uint256(SAMPLE_DEVICE_ID));

        vm.expectEmit(true, true, false, true);
        emit EnergyProofRegistryV3.ProofSubmitted(
            expectedDeviceIdBytes32,
            expectedSessionKey,
            epochTs,
            0,      // first submission, gap = 0
            false   // not postDisconnection
        );

        vm.prank(operator);
        v3.submitProof(pubInputs, payloadHash, signature, validPubkey, proof);

        assertTrue(v3.usedSessionKeys(expectedSessionKey));
        assertEq(v3.lastSubmissionTimestamp(expectedDeviceIdBytes32), epochTs);
    }

    // ============================================================
    // Authorization failures
    // ============================================================

    function test_SubmitProof_RevertsForUnregisteredDevice() public {
        // otherPubkey was never registered in DeviceRegistry
        uint64 epochTs = uint64(block.timestamp);
        (
            PublicInputs memory pubInputs,
            bytes32 payloadHash,
            bytes memory signature,
            bytes memory proof
        ) = _buildSubmission(SAMPLE_DEVICE_ID, SAMPLE_SESSION_ID, epochTs);

        bytes32 expectedDeviceIdBytes32 = bytes32(uint256(SAMPLE_DEVICE_ID));

        vm.expectRevert(
            abi.encodeWithSelector(
                EnergyProofRegistryV3.DeviceNotActive.selector,
                expectedDeviceIdBytes32
            )
        );
        vm.prank(operator);
        v3.submitProof(pubInputs, payloadHash, signature, otherPubkey, proof);
    }

    function test_SubmitProof_RevertsForRevokedDevice() public {
        vm.prank(operator);
        registry.revokeDevice(validPubkey);

        uint64 epochTs = uint64(block.timestamp);
        (
            PublicInputs memory pubInputs,
            bytes32 payloadHash,
            bytes memory signature,
            bytes memory proof
        ) = _buildSubmission(SAMPLE_DEVICE_ID, SAMPLE_SESSION_ID, epochTs);

        bytes32 expectedDeviceIdBytes32 = bytes32(uint256(SAMPLE_DEVICE_ID));

        vm.expectRevert(
            abi.encodeWithSelector(
                EnergyProofRegistryV3.DeviceNotActive.selector,
                expectedDeviceIdBytes32
            )
        );
        vm.prank(operator);
        v3.submitProof(pubInputs, payloadHash, signature, validPubkey, proof);
    }

    function test_SubmitProof_RevertsForSuspendedDevice() public {
        vm.prank(operator);
        registry.suspendDevice(validPubkey);

        uint64 epochTs = uint64(block.timestamp);
        (
            PublicInputs memory pubInputs,
            bytes32 payloadHash,
            bytes memory signature,
            bytes memory proof
        ) = _buildSubmission(SAMPLE_DEVICE_ID, SAMPLE_SESSION_ID, epochTs);

        bytes32 expectedDeviceIdBytes32 = bytes32(uint256(SAMPLE_DEVICE_ID));

        vm.expectRevert(
            abi.encodeWithSelector(
                EnergyProofRegistryV3.DeviceNotActive.selector,
                expectedDeviceIdBytes32
            )
        );
        vm.prank(operator);
        v3.submitProof(pubInputs, payloadHash, signature, validPubkey, proof);
    }

    // ============================================================
    // Lifecycle: reactivation
    // ============================================================

    function test_SubmitProof_SuccessAfterReactivation() public {
        // Revoke then reactivate
        vm.startPrank(operator);
        registry.revokeDevice(validPubkey);
        registry.reactivateDevice(validPubkey);
        vm.stopPrank();

        uint64 epochTs = uint64(block.timestamp);
        (
            PublicInputs memory pubInputs,
            bytes32 payloadHash,
            bytes memory signature,
            bytes memory proof
        ) = _buildSubmission(SAMPLE_DEVICE_ID, SAMPLE_SESSION_ID, epochTs);

        vm.prank(operator);
        v3.submitProof(pubInputs, payloadHash, signature, validPubkey, proof);

        bytes32 expectedSessionKey =
            keccak256(abi.encodePacked(SAMPLE_DEVICE_ID, SAMPLE_SESSION_ID));
        assertTrue(v3.usedSessionKeys(expectedSessionKey));
    }

    function test_SubmitProof_SuccessAfterReactivationFromSuspend() public {
        // Suspend then reactivate
        vm.startPrank(operator);
        registry.suspendDevice(validPubkey);
        registry.reactivateDevice(validPubkey);
        vm.stopPrank();

        uint64 epochTs = uint64(block.timestamp);
        (
            PublicInputs memory pubInputs,
            bytes32 payloadHash,
            bytes memory signature,
            bytes memory proof
        ) = _buildSubmission(SAMPLE_DEVICE_ID, SAMPLE_SESSION_ID, epochTs);

        vm.prank(operator);
        v3.submitProof(pubInputs, payloadHash, signature, validPubkey, proof);

        bytes32 expectedSessionKey =
            keccak256(abi.encodePacked(SAMPLE_DEVICE_ID, SAMPLE_SESSION_ID));
        assertTrue(v3.usedSessionKeys(expectedSessionKey));
    }

    // ============================================================
    // Multi-device independence
    // ============================================================

    function test_SubmitProof_TwoDevicesIndependent() public {
        // Register otherPubkey too
        vm.prank(operator);
        registry.registerDevice(otherPubkey, 100_000_000, 100_000_000);

        // Submit from validPubkey (device 1001)
        uint64 epochTs1 = uint64(block.timestamp);
        (
            PublicInputs memory pi1,
            bytes32 ph1,
            bytes memory sig1,
            bytes memory proof1
        ) = _buildSubmission(1001, 1, epochTs1);
        vm.prank(operator);
        v3.submitProof(pi1, ph1, sig1, validPubkey, proof1);

        // Revoke validPubkey
        vm.prank(operator);
        registry.revokeDevice(validPubkey);

        // otherPubkey (device 1002) should still work — advance time slightly
        vm.warp(block.timestamp + 60);
        uint64 epochTs2 = uint64(block.timestamp);
        (
            PublicInputs memory pi2,
            bytes32 ph2,
            bytes memory sig2,
            bytes memory proof2
        ) = _buildSubmission(1002, 1, epochTs2);
        vm.prank(operator);
        v3.submitProof(pi2, ph2, sig2, otherPubkey, proof2);

        // Verify both submissions recorded
        assertTrue(v3.usedSessionKeys(keccak256(abi.encodePacked(uint64(1001), uint64(1)))));
        assertTrue(v3.usedSessionKeys(keccak256(abi.encodePacked(uint64(1002), uint64(1)))));

        // Verify validPubkey now blocked but otherPubkey accepted
        assertFalse(registry.isAuthorized(validPubkey));
        assertTrue(registry.isAuthorized(otherPubkey));
    }

    // ============================================================
    // Helpers
    // ============================================================

    /// @dev Build valid submitProof inputs. Since P-256 and Honk verifiers are mocked
    ///      to return true, the cryptographic content of signature/proof is irrelevant —
    ///      only length validation in V3 matters (64 bytes for signature/pubkey).
    function _buildSubmission(uint64 deviceId, uint64 sessionId, uint64 epochTs)
        internal
        pure
        returns (
            PublicInputs memory pubInputs,
            bytes32 payloadHash,
            bytes memory signature,
            bytes memory proof
        )
    {
        payloadHash = keccak256(abi.encode(deviceId, sessionId, epochTs));

        pubInputs = PublicInputs({
            deviceId: deviceId,
            sessionId: sessionId,
            epochStartTs: epochTs,
            lat_e7: int64(484_500_000),
            lon_e7: int64(255_500_000),
            lightLevel: 1000,
            tamperFlag: 0,
            payloadHash: payloadHash,
            totalEnergyMWh: 100
        });

        signature = new bytes(64); // P256_SIGNATURE_LENGTH
        proof = new bytes(128);    // arbitrary length (HonkVerifier mock ignores content)
    }
}
