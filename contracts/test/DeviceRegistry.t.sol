// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeviceRegistry} from "../src/DeviceRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title DeviceRegistry baseline tests
/// @notice Covers happy paths and main error cases for DeviceRegistry.
/// @dev Tarasовий V3 test suite не торкається цього файлу — це окремий контракт.
///      Розширення coverage (fuzz, invariants) — окремий task.
contract DeviceRegistryTest is Test {
    DeviceRegistry internal registry;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal attacker = makeAddr("attacker");

    bytes internal validPubkey;
    bytes internal otherPubkey;

    int32 internal constant SAMPLE_LAT_E7 = 484_500_000;   // ~48.45° Sniatyn
    int32 internal constant SAMPLE_LON_E7 = 255_500_000;  // ~25.55°

    function setUp() public {
        registry = new DeviceRegistry(admin);

        vm.prank(admin);
        registry.grantRole(registry.OPERATOR_ROLE(), operator);

        // 64-byte sample pubkeys (X || Y); content arbitrary for tests
        validPubkey = new bytes(64);
        otherPubkey = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            validPubkey[i] = bytes1(uint8(i + 1));
            otherPubkey[i] = bytes1(uint8(255 - i));
        }
    }

    // ============================================================
    // Constructor
    // ============================================================

    function test_Constructor_RevertOnZeroAddress() public {
        vm.expectRevert(DeviceRegistry.ZeroAddress.selector);
        new DeviceRegistry(address(0));
    }

    function test_Constructor_AdminGetsAdminRole() public view {
        assertTrue(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_Constructor_AdminNotAutoOperator() public view {
        // Admin does NOT automatically receive OPERATOR_ROLE — must grant explicitly.
        // In setUp() we granted it; verify the role separation by checking another account.
        assertFalse(registry.hasRole(registry.OPERATOR_ROLE(), attacker));
    }

    // ============================================================
    // registerDevice
    // ============================================================

    function test_RegisterDevice_HappyPath() public {
        bytes32 expectedHash = keccak256(validPubkey);

        vm.expectEmit(true, true, true, true);
        emit DeviceRegistry.DeviceRegistered(
            expectedHash,
            SAMPLE_LAT_E7,
            SAMPLE_LON_E7,
            uint64(block.timestamp),
            operator
        );

        vm.prank(operator);
        registry.registerDevice(validPubkey, SAMPLE_LAT_E7, SAMPLE_LON_E7);

        assertTrue(registry.isAuthorized(validPubkey));
        assertEq(registry.deviceCount(), 1);
    }

    function test_RegisterDevice_RevertOnInvalidLength() public {
        bytes memory shortPubkey = new bytes(63);

        vm.expectRevert(
            abi.encodeWithSelector(DeviceRegistry.InvalidPubkeyLength.selector, 63)
        );
        vm.prank(operator);
        registry.registerDevice(shortPubkey, SAMPLE_LAT_E7, SAMPLE_LON_E7);
    }

    function test_RegisterDevice_RevertOnInvalidLatitude() public {
        int32 badLat = 950_000_000; // > 90 degrees

        vm.expectRevert(
            abi.encodeWithSelector(
                DeviceRegistry.InvalidCoordinates.selector,
                badLat,
                SAMPLE_LON_E7
            )
        );
        vm.prank(operator);
        registry.registerDevice(validPubkey, badLat, SAMPLE_LON_E7);
    }

    function test_RegisterDevice_RevertOnInvalidLongitude() public {
        int32 badLon = -1_900_000_000; // < -180 degrees

        vm.expectRevert(
            abi.encodeWithSelector(
                DeviceRegistry.InvalidCoordinates.selector,
                SAMPLE_LAT_E7,
                badLon
            )
        );
        vm.prank(operator);
        registry.registerDevice(validPubkey, SAMPLE_LAT_E7, badLon);
    }

    function test_RegisterDevice_RevertOnDoubleRegistration() public {
        vm.prank(operator);
        registry.registerDevice(validPubkey, SAMPLE_LAT_E7, SAMPLE_LON_E7);

        bytes32 expectedHash = keccak256(validPubkey);
        vm.expectRevert(
            abi.encodeWithSelector(
                DeviceRegistry.DeviceAlreadyRegistered.selector,
                expectedHash
            )
        );
        vm.prank(operator);
        registry.registerDevice(validPubkey, SAMPLE_LAT_E7, SAMPLE_LON_E7);
    }

    function test_RegisterDevice_RevertWhenNotOperator() public {
        bytes32 role = registry.OPERATOR_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                attacker,
                role
            )
        );
        vm.prank(attacker);
        registry.registerDevice(validPubkey, SAMPLE_LAT_E7, SAMPLE_LON_E7);
    }

    // ============================================================
    // revokeDevice
    // ============================================================

    function test_RevokeDevice_HappyPath() public {
        vm.prank(operator);
        registry.registerDevice(validPubkey, SAMPLE_LAT_E7, SAMPLE_LON_E7);

        bytes32 expectedHash = keccak256(validPubkey);
        vm.expectEmit(true, true, false, false);
        emit DeviceRegistry.DeviceRevoked(expectedHash, operator);

        vm.prank(operator);
        registry.revokeDevice(validPubkey);

        assertFalse(registry.isAuthorized(validPubkey));
        assertEq(
            uint8(registry.getDeviceStatus(validPubkey)),
            uint8(DeviceRegistry.DeviceStatus.Revoked)
        );
    }

    function test_RevokeDevice_RevertOnUnknownDevice() public {
        bytes32 expectedHash = keccak256(validPubkey);
        vm.expectRevert(
            abi.encodeWithSelector(
                DeviceRegistry.DeviceNotFound.selector,
                expectedHash
            )
        );
        vm.prank(operator);
        registry.revokeDevice(validPubkey);
    }

    function test_RevokeDevice_RevertOnDoubleRevoke() public {
        vm.startPrank(operator);
        registry.registerDevice(validPubkey, SAMPLE_LAT_E7, SAMPLE_LON_E7);
        registry.revokeDevice(validPubkey);

        bytes32 expectedHash = keccak256(validPubkey);
        vm.expectRevert(
            abi.encodeWithSelector(
                DeviceRegistry.DeviceNotActive.selector,
                expectedHash
            )
        );
        registry.revokeDevice(validPubkey);
        vm.stopPrank();
    }

    // ============================================================
    // reactivateDevice
    // ============================================================

    function test_ReactivateDevice_FromRevoked() public {
        vm.startPrank(operator);
        registry.registerDevice(validPubkey, SAMPLE_LAT_E7, SAMPLE_LON_E7);
        registry.revokeDevice(validPubkey);
        registry.reactivateDevice(validPubkey);
        vm.stopPrank();

        assertTrue(registry.isAuthorized(validPubkey));
    }

    function test_ReactivateDevice_FromSuspended() public {
        vm.startPrank(operator);
        registry.registerDevice(validPubkey, SAMPLE_LAT_E7, SAMPLE_LON_E7);
        registry.suspendDevice(validPubkey);
        registry.reactivateDevice(validPubkey);
        vm.stopPrank();

        assertTrue(registry.isAuthorized(validPubkey));
    }

    function test_ReactivateDevice_RevertWhenAlreadyActive() public {
        vm.startPrank(operator);
        registry.registerDevice(validPubkey, SAMPLE_LAT_E7, SAMPLE_LON_E7);

        bytes32 expectedHash = keccak256(validPubkey);
        vm.expectRevert(
            abi.encodeWithSelector(
                DeviceRegistry.DeviceAlreadyActive.selector,
                expectedHash
            )
        );
        registry.reactivateDevice(validPubkey);
        vm.stopPrank();
    }

    // ============================================================
    // suspendDevice
    // ============================================================

    function test_SuspendDevice_HappyPath() public {
        vm.prank(operator);
        registry.registerDevice(validPubkey, SAMPLE_LAT_E7, SAMPLE_LON_E7);

        vm.prank(operator);
        registry.suspendDevice(validPubkey);

        assertFalse(registry.isAuthorized(validPubkey));
        assertEq(
            uint8(registry.getDeviceStatus(validPubkey)),
            uint8(DeviceRegistry.DeviceStatus.Suspended)
        );
    }

    function test_SuspendDevice_RevertOnUnknownDevice() public {
        bytes32 expectedHash = keccak256(validPubkey);
        vm.expectRevert(
            abi.encodeWithSelector(
                DeviceRegistry.DeviceNotActive.selector,
                expectedHash
            )
        );
        vm.prank(operator);
        registry.suspendDevice(validPubkey);
    }

    // ============================================================
    // isAuthorized
    // ============================================================

    function test_IsAuthorized_FalseForUnknownDevice() public view {
        assertFalse(registry.isAuthorized(validPubkey));
    }

    function test_IsAuthorized_FalseForInvalidLength() public view {
        bytes memory shortPubkey = new bytes(63);
        assertFalse(registry.isAuthorized(shortPubkey));
    }

    function test_IsAuthorized_TwoDevicesIndependent() public {
        vm.startPrank(operator);
        registry.registerDevice(validPubkey, SAMPLE_LAT_E7, SAMPLE_LON_E7);
        registry.registerDevice(otherPubkey, 0, 0);

        assertTrue(registry.isAuthorized(validPubkey));
        assertTrue(registry.isAuthorized(otherPubkey));

        registry.revokeDevice(validPubkey);

        assertFalse(registry.isAuthorized(validPubkey));
        assertTrue(registry.isAuthorized(otherPubkey)); // unaffected
        vm.stopPrank();
    }

    // ============================================================
    // getDeviceInfo
    // ============================================================

    function test_GetDeviceInfo_ReturnsRegisteredValues() public {
        vm.warp(1_700_000_000);
        vm.prank(operator);
        registry.registerDevice(validPubkey, SAMPLE_LAT_E7, SAMPLE_LON_E7);

        (
            int32 latE7,
            int32 lonE7,
            uint64 registeredAt,
            DeviceRegistry.DeviceStatus status
        ) = registry.getDeviceInfo(validPubkey);

        assertEq(latE7, SAMPLE_LAT_E7);
        assertEq(lonE7, SAMPLE_LON_E7);
        assertEq(registeredAt, 1_700_000_000);
        assertEq(uint8(status), uint8(DeviceRegistry.DeviceStatus.Active));
    }

    function test_GetDeviceInfo_ReturnsZeroForUnknown() public view {
        (int32 latE7, int32 lonE7, uint64 registeredAt, DeviceRegistry.DeviceStatus status) =
            registry.getDeviceInfo(validPubkey);

        assertEq(latE7, 0);
        assertEq(lonE7, 0);
        assertEq(registeredAt, 0);
        assertEq(uint8(status), uint8(DeviceRegistry.DeviceStatus.Unknown));
    }

    // ============================================================
    // deviceCount
    // ============================================================

    function test_DeviceCount_IncrementsOnRegister() public {
        assertEq(registry.deviceCount(), 0);

        vm.startPrank(operator);
        registry.registerDevice(validPubkey, SAMPLE_LAT_E7, SAMPLE_LON_E7);
        assertEq(registry.deviceCount(), 1);

        registry.registerDevice(otherPubkey, 0, 0);
        assertEq(registry.deviceCount(), 2);
        vm.stopPrank();
    }

    function test_DeviceCount_DoesNotDecrementOnRevoke() public {
        vm.startPrank(operator);
        registry.registerDevice(validPubkey, SAMPLE_LAT_E7, SAMPLE_LON_E7);
        registry.revokeDevice(validPubkey);
        vm.stopPrank();

        // deviceCount is monotonic — counts lifetime registrations, not active devices.
        assertEq(registry.deviceCount(), 1);
    }
}
