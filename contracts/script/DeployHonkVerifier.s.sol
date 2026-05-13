// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {HonkVerifier} from "../vendor/HonkVerifier.sol";

/// @title DeployHonkVerifier
/// @notice Standalone deployment of the bb-generated HonkVerifier from v08 circuit.
/// @dev Run before Deploy.s.sol; export result as HONK_VERIFIER_ADDRESS env var.
///      forge script script/DeployHonkVerifier.s.sol --rpc-url $RPC_URL --private-key $PRIVATE_KEY --broadcast
contract DeployHonkVerifier is Script {
    function run() external returns (address verifierAddr) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        HonkVerifier verifier = new HonkVerifier();
        verifierAddr = address(verifier);

        vm.stopBroadcast();

        console.log("=== HonkVerifier Deployed ===");
        console.log("Address:", verifierAddr);
        console.log("");
        console.log("Next: export HONK_VERIFIER_ADDRESS=", verifierAddr);
        console.log("Then run: forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast");
    }
}
