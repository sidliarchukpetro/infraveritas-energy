// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {DeviceRegistry} from "../src/DeviceRegistry.sol";
import {EnergyProofRegistryV3} from "../src/EnergyProofRegistryV3.sol";
import {MockP256Verifier} from "../test/mocks/MockP256Verifier.sol";
import {MockHonkVerifier} from "../test/mocks/MockHonkVerifier.sol";

/// @title DeployLocal
/// @notice Local deployment for anvil — deploys full stack including mock verifiers.
/// @dev Uses anvil's well-known default accounts if PRIVATE_KEY / OPERATOR_ADDRESS not set:
///        Account 0 (0xf39F...): deployer = admin, private key 0xac0974...
///        Account 1 (0x7099...): operator
///      Mocks always return true from verify(), so any well-formed submitProof passes the
///      crypto checks. This lets you test the full V3 + DeviceRegistry authorization flow
///      end-to-end without needing real ECDSA signatures or ZK proofs.
contract DeployLocal is Script {
    // Anvil default private key for account 0
    uint256 private constant ANVIL_DEFAULT_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    // Anvil default address for account 1
    address private constant ANVIL_ACCOUNT_1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    function run()
        external
        returns (
            address deviceRegistryAddr,
            address v3ProxyAddr,
            address p256MockAddr,
            address honkMockAddr
        )
    {
        uint256 deployerKey = vm.envOr("PRIVATE_KEY", ANVIL_DEFAULT_KEY);
        address admin = vm.addr(deployerKey);
        address operator = vm.envOr("OPERATOR_ADDRESS", ANVIL_ACCOUNT_1);

        vm.startBroadcast(deployerKey);

        // 1. Deploy mocks
        MockP256Verifier p256Mock = new MockP256Verifier();
        MockHonkVerifier honkMock = new MockHonkVerifier();
        p256MockAddr = address(p256Mock);
        honkMockAddr = address(honkMock);

        // 2. Deploy DeviceRegistry
        DeviceRegistry registry = new DeviceRegistry(admin);
        deviceRegistryAddr = address(registry);
        registry.grantRole(registry.OPERATOR_ROLE(), operator);

        // 3. Deploy V3 implementation + ERC1967 proxy
        EnergyProofRegistryV3 implementation = new EnergyProofRegistryV3();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(
                EnergyProofRegistryV3.initialize,
                (admin, address(registry), p256MockAddr, honkMockAddr)
            )
        );
        v3ProxyAddr = address(proxy);

        // 4. Grant V3 operator role
        EnergyProofRegistryV3 v3 = EnergyProofRegistryV3(v3ProxyAddr);
        v3.grantRole(v3.OPERATOR_ROLE(), operator);

        vm.stopBroadcast();

        console.log("=== Local Deployment Complete (anvil) ===");
        console.log("DeviceRegistry    :", deviceRegistryAddr);
        console.log("V3 implementation :", address(implementation));
        console.log("V3 proxy          :", v3ProxyAddr);
        console.log("P256 mock         :", p256MockAddr);
        console.log("Honk mock         :", honkMockAddr);
        console.log("Admin             :", admin);
        console.log("Operator          :", operator);
        console.log("");
        console.log("Mocks default to verify()==true. Use mock.setShouldReturnTrue(false)");
        console.log("to test crypto-failure paths.");
    }
}
