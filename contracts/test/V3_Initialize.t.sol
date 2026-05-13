// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { EnergyProofRegistryV3 } from "../src/EnergyProofRegistryV3.sol";
import { MockDeviceRegistry } from "./mocks/MockDeviceRegistry.sol";
import { MockP256Verifier } from "./mocks/MockP256Verifier.sol";
import { MockHonkVerifier } from "./mocks/MockHonkVerifier.sol";

/// @title V3_Initialize
/// @notice Tests initialize() zero-address validation per V3 lines 128-131.
/// @dev Does NOT inherit V3TestBase — V3TestBase.setUp deploys a successful proxy,
///      which masks the zero-check branches. This file deploys proxies with bad
///      initData to exercise each ZeroAddress revert.
///
///      Pattern: deploy fresh impl + ERC1967Proxy(impl, badInitData).
///      The proxy constructor calls impl.initialize(...) in proxy storage context,
///      and the revert from zero-check propagates as a proxy deployment failure.
contract V3_Initialize_Test is Test {
    MockDeviceRegistry internal mockRegistry;
    MockP256Verifier internal mockP256;
    MockHonkVerifier internal mockHonk;
    address internal admin = makeAddr("admin");

    function setUp() public {
        // Mocks only — no V3 deployment here. Each test deploys its own impl + proxy
        // with custom (bad) initData.
        mockRegistry = new MockDeviceRegistry();
        mockP256 = new MockP256Verifier();
        mockHonk = new MockHonkVerifier();
    }

    /// @notice initialize() with admin == address(0) reverts ZeroAddress.
    function test_Revert_InitializeAdminZero() public {
        EnergyProofRegistryV3 impl = new EnergyProofRegistryV3();
        bytes memory initData = abi.encodeCall(
            EnergyProofRegistryV3.initialize,
            (address(0), address(mockRegistry), address(mockP256), address(mockHonk))
        );

        vm.expectRevert(EnergyProofRegistryV3.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    /// @notice initialize() with deviceRegistry == address(0) reverts ZeroAddress.
    function test_Revert_InitializeDeviceRegistryZero() public {
        EnergyProofRegistryV3 impl = new EnergyProofRegistryV3();
        bytes memory initData = abi.encodeCall(
            EnergyProofRegistryV3.initialize,
            (admin, address(0), address(mockP256), address(mockHonk))
        );

        vm.expectRevert(EnergyProofRegistryV3.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    /// @notice initialize() with p256Verifier == address(0) reverts ZeroAddress.
    function test_Revert_InitializeP256VerifierZero() public {
        EnergyProofRegistryV3 impl = new EnergyProofRegistryV3();
        bytes memory initData = abi.encodeCall(
            EnergyProofRegistryV3.initialize,
            (admin, address(mockRegistry), address(0), address(mockHonk))
        );

        vm.expectRevert(EnergyProofRegistryV3.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    /// @notice initialize() with honkVerifier == address(0) reverts ZeroAddress.
    function test_Revert_InitializeHonkVerifierZero() public {
        EnergyProofRegistryV3 impl = new EnergyProofRegistryV3();
        bytes memory initData = abi.encodeCall(
            EnergyProofRegistryV3.initialize,
            (admin, address(mockRegistry), address(mockP256), address(0))
        );

        vm.expectRevert(EnergyProofRegistryV3.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }
}
