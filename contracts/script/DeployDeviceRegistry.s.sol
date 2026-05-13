// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {DeviceRegistry} from "../src/DeviceRegistry.sol";

/// @title DeployDeviceRegistry
/// @notice Standalone deployment of DeviceRegistry - for cases where V3 is already deployed
///         and only the registry needs replacement.
/// @dev After deploying, call `v3.setDeviceRegistry(newRegistryAddress)` from V3 admin
///      to point V3 at the new registry. Requires re-registration of all devices.
contract DeployDeviceRegistry is Script {
    function run() external returns (address registryAddr) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address admin = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        DeviceRegistry registry = new DeviceRegistry(admin);
        registryAddr = address(registry);

        // Optional: grant operator role if provided
        address operator;
        try vm.envAddress("OPERATOR_ADDRESS") returns (address op) {
            operator = op;
        } catch {
            operator = address(0);
        }

        if (operator != address(0)) {
            registry.grantRole(registry.OPERATOR_ROLE(), operator);
        }

        vm.stopBroadcast();

        console.log("=== DeviceRegistry Deployment Complete ===");
        console.log("DeviceRegistry :", registryAddr);
        console.log("Admin          :", admin);
        if (operator != address(0)) {
            console.log("Operator       :", operator);
        } else {
            console.log("Operator       : (not set - grant OPERATOR_ROLE manually)");
        }
        console.log("");
        console.log("Next step: call v3.setDeviceRegistry on existing V3 from admin");
    }
}
