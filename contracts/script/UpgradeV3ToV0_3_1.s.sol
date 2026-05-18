// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {EnergyProofRegistryV3} from "../src/EnergyProofRegistryV3.sol";

/// @title UpgradeV3ToV0_3_1 — Sepolia revert script (v0.3 → v0.3.1)
///
/// @notice Deploys new V3 implementation with CHECK 2 reverted to verify
///         signature over Poseidon payloadHash (instead of EIP-712 digest).
///
///         Rationale: Noir circuit (zk/circuits/v08) verifies signature
///         over payload_hash via std::ecdsa_secp256r1::verify_signature.
///         Same signature cannot satisfy both circuit (payloadHash) and
///         V3 v0.3 (EIP-712 digest). Multi-day circuit redesign deferred.
///
///         EIP-712 infrastructure (domainSeparator, eip712Digest view,
///         reinitializer) RETAINED for future signed-message features
///         (admin operations, off-chain orders). No reinit needed —
///         EIP-712 cache from v0.3 still valid.
///
/// @dev Caller MUST have UPGRADER_ROLE on the proxy (operator EOA on Sepolia).
///
/// Usage:
///
///   export RPC_URL=https://eth-sepolia.g.alchemy.com/v2/...
///   export OPERATOR_PRIVATE_KEY=0x...
///
///   # Dry run (simulate)
///   forge script contracts/script/UpgradeV3ToV0_3_1.s.sol \
///     --rpc-url $RPC_URL \
///     --sender 0xD1Cb30374a2D0D1B3fd9830eAAFf527D5FC13f5f \
///     -vvv
///
///   # Real broadcast
///   forge script contracts/script/UpgradeV3ToV0_3_1.s.sol \
///     --rpc-url $RPC_URL \
///     --private-key $OPERATOR_PRIVATE_KEY \
///     --broadcast \
///     -vvv
contract UpgradeV3ToV0_3_1 is Script {
    /// @dev V3 proxy address on Sepolia.
    address constant V3_PROXY = 0xF21D900E43214b0AbF489f8D6862352aaBB09DA3;

    /// @dev ERC1967 implementation slot.
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
        console.log("Current (v0.3) implementation:");
        console.logAddress(oldImpl);
        console.log("Chain ID:", block.chainid);

        vm.startBroadcast();

        // ---- Step 1: deploy new V3 implementation (v0.3.1 with reverted CHECK 2) ----

        EnergyProofRegistryV3 newImpl = new EnergyProofRegistryV3();

        console.log("");
        console.log("=== Step 1: New V3 v0.3.1 implementation deployed ===");
        console.log("New impl address:");
        console.logAddress(address(newImpl));

        // ---- Step 2: upgrade proxy (no reinit — EIP-712 cache from v0.3 still valid) ----

        EnergyProofRegistryV3(V3_PROXY).upgradeToAndCall(
            address(newImpl),
            ""  // empty calldata — just swap impl, no reinit needed
        );

        console.log("");
        console.log("=== Step 2: Proxy upgraded ===");
        console.log("(No reinit needed — EIP-712 cache from v0.3 still valid)");

        // ---- Step 3: verify post-upgrade state ----

        // domainSeparator must still work — infrastructure retained
        bytes32 separator = EnergyProofRegistryV3(V3_PROXY).domainSeparator();

        console.log("");
        console.log("=== Step 3: Post-upgrade verification ===");
        console.log("Domain separator (unchanged from v0.3):");
        console.logBytes32(separator);
        console.log("V3 proxy address (unchanged):");
        console.logAddress(V3_PROXY);

        vm.stopBroadcast();

        // ---- Final summary ----

        bytes32 newImplSlot = vm.load(V3_PROXY, ERC1967_IMPL_SLOT);
        address postUpgradeImpl = address(uint160(uint256(newImplSlot)));

        console.log("");
        console.log("=== Upgrade complete (v0.3 -> v0.3.1) ===");
        console.log("Old impl (v0.3):");
        console.logAddress(oldImpl);
        console.log("New impl (v0.3.1):");
        console.logAddress(postUpgradeImpl);
        console.log("");
        console.log("Signature now verified over payloadHash (Poseidon) — matches");
        console.log("circuit and aggregator pre-check. EIP-712 infra retained but");
        console.log("unused for submitProof signature.");
        console.log("");
        console.log("Next: re-run edge/scripts/sepolia_smoke.py for E2E test.");
    }
}
