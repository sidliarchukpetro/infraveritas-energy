// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EnergyProofRegistryV3} from "../src/EnergyProofRegistryV3.sol";

/// @title UpgradeV3ToV0_3 — Sepolia upgrade script (v0.2 → v0.3)
///
/// @notice Upgrades existing V3 proxy on Sepolia from v0.2 to v0.3 (EIP-712
///         typed signing layer). Atomic upgrade + reinitialize EIP-712 cache
///         in single transaction — if reinit reverts, upgrade reverts too,
///         proxy stays on v0.2 (safe rollback).
///
/// @dev Caller MUST have DEFAULT_ADMIN_ROLE + UPGRADER_ROLE on the proxy.
///      On current Sepolia deployment, this is the operator EOA at
///      0xD1Cb30374a2D0D1B3fd9830eAAFf527D5FC13f5f.
///
/// Usage (dry run — simulate, no broadcast):
///
///   forge script contracts/script/UpgradeV3ToV0_3.s.sol \
///     --rpc-url $SEPOLIA_RPC_URL -vvv
///
/// Usage (real broadcast):
///
///   export SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/...
///   export OPERATOR_PRIVATE_KEY=0x...
///
///   forge script contracts/script/UpgradeV3ToV0_3.s.sol \
///     --rpc-url $SEPOLIA_RPC_URL \
///     --private-key $OPERATOR_PRIVATE_KEY \
///     --broadcast \
///     -vvv
contract UpgradeV3ToV0_3 is Script {
    /// @dev V3 proxy address on Sepolia (deployed 2026-05-14, Phase 1 closure).
    address constant V3_PROXY = 0xF21D900E43214b0AbF489f8D6862352aaBB09DA3;

    /// @dev ERC1967 implementation slot — bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
    bytes32 constant ERC1967_IMPL_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function run() external {
        // ---- Pre-upgrade state inspection ----

        bytes32 oldImplSlot = vm.load(V3_PROXY, ERC1967_IMPL_SLOT);
        address oldImpl = address(uint160(uint256(oldImplSlot)));

        console.log("");
        console.log("=== Pre-upgrade state ===");
        console.log("V3 proxy:");
        console.logAddress(V3_PROXY);
        console.log("Current (v0.2) implementation:");
        console.logAddress(oldImpl);
        console.log("Chain ID:", block.chainid);

        // ---- Begin broadcast ----

        vm.startBroadcast();

        // ---- Step 1: deploy new V3 implementation (v0.3 with EIP-712) ----

        EnergyProofRegistryV3 newImpl = new EnergyProofRegistryV3();

        console.log("");
        console.log("=== Step 1: New V3 v0.3 implementation deployed ===");
        console.log("New impl address:");
        console.logAddress(address(newImpl));

        // ---- Step 2: atomic upgrade + reinitialize EIP-712 cache ----

        // upgradeToAndCall(newImpl, encodedReinitCall) atomically:
        //   1. Checks _authorizeUpgrade (UPGRADER_ROLE on msg.sender)
        //   2. Sets ERC1967 implementation slot to newImpl
        //   3. Delegatecalls reinitializeEIP712() through proxy
        //
        // If reinitializeEIP712 reverts (e.g. wrong reinitializer version,
        // role check), the whole transaction reverts — proxy stays on v0.2.
        // This is the safe atomic rollback property.

        bytes memory reinitData = abi.encodeCall(
            EnergyProofRegistryV3.reinitializeEIP712,
            ()
        );

        EnergyProofRegistryV3(V3_PROXY).upgradeToAndCall(
            address(newImpl),
            reinitData
        );

        console.log("");
        console.log("=== Step 2: Proxy upgraded + EIP-712 cache initialized ===");

        // ---- Step 3: verify post-upgrade state ----

        bytes32 separator = EnergyProofRegistryV3(V3_PROXY).domainSeparator();

        console.log("");
        console.log("=== Step 3: Post-upgrade verification ===");
        console.log("Domain separator on proxy:");
        console.logBytes32(separator);
        console.log("V3 proxy address (unchanged):");
        console.logAddress(V3_PROXY);

        vm.stopBroadcast();

        // ---- Final summary ----

        bytes32 newImplSlot = vm.load(V3_PROXY, ERC1967_IMPL_SLOT);
        address postUpgradeImpl = address(uint160(uint256(newImplSlot)));

        console.log("");
        console.log("=== Upgrade complete ===");
        console.log("Old impl:");
        console.logAddress(oldImpl);
        console.log("New impl:");
        console.logAddress(postUpgradeImpl);
        console.log("");
        console.log("Next steps:");
        console.log("  1. Verify on Etherscan:");
        console.log("     https://sepolia.etherscan.io/address/0xF21D900E43214b0AbF489f8D6862352aaBB09DA3");
        console.log("  2. Run E2E test:");
        console.log("     cd edge && python scripts/sepolia_smoke.py");
    }
}
