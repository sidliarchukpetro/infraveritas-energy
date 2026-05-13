// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {DeviceRegistry} from "../src/DeviceRegistry.sol";
import {EnergyProofRegistryV3} from "../src/EnergyProofRegistryV3.sol";

/// @title Deploy
/// @notice Production-style deployment of DeviceRegistry + V3 (impl + ERC1967Proxy).
/// @dev Deployer's address becomes the initial DEFAULT_ADMIN_ROLE on both contracts.
///      Required env vars: PRIVATE_KEY, OPERATOR_ADDRESS, P256_VERIFIER_ADDRESS, HONK_VERIFIER_ADDRESS.
///      Optional env vars: TEST_DEVICE_PUBKEY (64 bytes), TEST_DEVICE_LAT_E7, TEST_DEVICE_LON_E7.
///
///      Post-deploy operational steps (outside this script):
///        - Transfer DEFAULT_ADMIN_ROLE to a multisig (renounce on deployer)
///        - Verify contracts on Etherscan (use --verify flag with forge script)
///        - Record addresses in deployments/<network>.json
contract Deploy is Script {
    function run()
        external
        returns (
            address deviceRegistryAddr,
            address v3Implementation,
            address v3ProxyAddr
        )
    {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address admin = vm.addr(deployerKey);
        address operator = vm.envAddress("OPERATOR_ADDRESS");
        address p256Verifier = vm.envAddress("P256_VERIFIER_ADDRESS");
        address honkVerifier = vm.envAddress("HONK_VERIFIER_ADDRESS");

        require(operator != address(0), "OPERATOR_ADDRESS not set");
        require(p256Verifier != address(0), "P256_VERIFIER_ADDRESS not set");
        require(honkVerifier != address(0), "HONK_VERIFIER_ADDRESS not set");

        // Optional test device registration
        bytes memory testPubkey;
        try vm.envBytes("TEST_DEVICE_PUBKEY") returns (bytes memory v) {
            testPubkey = v;
        } catch {
            testPubkey = "";
        }

        vm.startBroadcast(deployerKey);

        // 1. DeviceRegistry
        DeviceRegistry registry = new DeviceRegistry(admin);
        deviceRegistryAddr = address(registry);

        // 2. Grant OPERATOR_ROLE to operator on DeviceRegistry
        registry.grantRole(registry.OPERATOR_ROLE(), operator);

        // 3. Optional: register a test device for end-to-end testing
        if (testPubkey.length == 64) {
            int256 latRaw = vm.envOr("TEST_DEVICE_LAT_E7", int256(0));
            int256 lonRaw = vm.envOr("TEST_DEVICE_LON_E7", int256(0));
            // DeviceRegistry validates coordinate bounds in registerDevice
            registry.registerDevice(testPubkey, int32(latRaw), int32(lonRaw));
        }

        // 4. V3 implementation
        EnergyProofRegistryV3 implementation = new EnergyProofRegistryV3();
        v3Implementation = address(implementation);

        // 5. V3 proxy with initialize
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(
                EnergyProofRegistryV3.initialize,
                (admin, address(registry), p256Verifier, honkVerifier)
            )
        );
        v3ProxyAddr = address(proxy);

        // 6. Grant OPERATOR_ROLE to operator on V3 proxy
        EnergyProofRegistryV3 v3 = EnergyProofRegistryV3(v3ProxyAddr);
        v3.grantRole(v3.OPERATOR_ROLE(), operator);

        vm.stopBroadcast();

        console.log("=== Deployment Complete ===");
        console.log("DeviceRegistry        :", deviceRegistryAddr);
        console.log("V3 implementation     :", v3Implementation);
        console.log("V3 proxy              :", v3ProxyAddr);
        console.log("P256 verifier (extern):", p256Verifier);
        console.log("Honk verifier (extern):", honkVerifier);
        console.log("Admin (deployer)      :", admin);
        console.log("Operator              :", operator);
        if (testPubkey.length == 64) {
            console.log("Test device registered: yes");
        } else {
            console.log("Test device registered: no (TEST_DEVICE_PUBKEY not set or invalid length)");
        }
    }
}
