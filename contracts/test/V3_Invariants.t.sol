// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {EnergyProofRegistryV3, PublicInputs} from "../src/EnergyProofRegistryV3.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

// ============================================================================
// Mocks — mirror the Echidna harness mocks for consistency
// ============================================================================

contract MockDeviceRegistryInv {
    mapping(bytes32 => bool) public authorized;

    function setAuthorized(bytes calldata pk, bool ok) external {
        authorized[keccak256(pk)] = ok;
    }

    function isAuthorized(bytes calldata pk) external view returns (bool) {
        return authorized[keccak256(pk)];
    }
}

contract MockP256VerifierInvTrue {
    function verify(bytes32, bytes32, bytes32, bytes32, bytes32)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

contract MockHonkVerifierInvTrue {
    function verify(bytes calldata, bytes32[] calldata)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

// ============================================================================
// V3InvariantHandler
//
// Forge invariant runner calls this handler's `submit()` with random inputs.
// On a successful submit, the handler captures the emitted ProofSubmitted
// event together with the two payload-hash inputs (the one in PublicInputs
// struct vs the one passed as a separate argument). The invariant tests
// then assert two relationships that must always hold:
//   #4 postDisconnection flag matches (gap > MAX_GAP_SECONDS)
//   #7 pi.payloadHash == param.payloadHash (V3 should revert otherwise)
// ============================================================================

contract V3InvariantHandler is Test {
    EnergyProofRegistryV3 public immutable v3;

    /// keccak256("ProofSubmitted(bytes32,bytes32,uint64,uint64,bool)")
    bytes32 internal constant PROOF_SUBMITTED_TOPIC =
        keccak256("ProofSubmitted(bytes32,bytes32,uint64,uint64,bool)");

    struct Capture {
        uint64 gapFromPrevious;
        bool postDisconnection;
        bytes32 piPayloadHash;
        bytes32 paramPayloadHash;
    }

    Capture[] internal _captures;

    uint64 internal constant DEVICE_COUNT = 5;

    constructor(EnergyProofRegistryV3 _v3) {
        v3 = _v3;
    }

    // -----------------------------------------------------------------------
    // Getters used by invariant assertions
    // -----------------------------------------------------------------------

    function getCaptureCount() external view returns (uint256) {
        return _captures.length;
    }

    function getCapture(uint256 i) external view returns (Capture memory) {
        return _captures[i];
    }

    // -----------------------------------------------------------------------
    // Fuzz target — Forge invariant runner calls this with random inputs.
    // piPayloadHash and paramPayloadHash are independent fuzz inputs so the
    // runner can attempt submissions with both matching and mismatched values.
    // -----------------------------------------------------------------------

    function submit(
        uint64 deviceIdSeed,
        uint64 sessionIdSeed,
        uint64 epochTsSeed,
        bytes32 piPayloadHash,
        bytes32 paramPayloadHash
    ) external {
        uint64 deviceId = (deviceIdSeed % DEVICE_COUNT) + 1;

        uint64 epochStartTs;
        unchecked {
            uint64 currentTs = uint64(block.timestamp);
            uint64 lookback = uint64(epochTsSeed % uint64(7 days));
            epochStartTs = currentTs > lookback ? currentTs - lookback : 1;
        }

        PublicInputs memory pi = PublicInputs({
            deviceId: deviceId,
            sessionId: sessionIdSeed,
            epochStartTs: epochStartTs,
            lat_e7: 0,
            lon_e7: 0,
            lightLevel: 0,
            tamperFlag: 0,
            payloadHash: piPayloadHash,
            totalEnergyMWh: 0
        });

        bytes memory signature = new bytes(64);
        bytes memory devicePubkey = _pubkey(deviceId);
        bytes memory proof = new bytes(440);

        vm.recordLogs();
        try v3.submitProof(pi, paramPayloadHash, signature, devicePubkey, proof) {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 i = 0; i < logs.length; i++) {
                if (logs[i].topics[0] == PROOF_SUBMITTED_TOPIC) {
                    (uint64 ts, uint64 gap, bool postDisconn) =
                        abi.decode(logs[i].data, (uint64, uint64, bool));
                    ts; // unused — only gap and flag matter for invariants

                    _captures.push(
                        Capture({
                            gapFromPrevious: gap,
                            postDisconnection: postDisconn,
                            piPayloadHash: piPayloadHash,
                            paramPayloadHash: paramPayloadHash
                        })
                    );
                }
            }
        } catch {
            // Revert path is expected for many fuzz inputs (paused, bad ts,
            // duplicate session, mismatched payload hash, etc.) — not a failure.
        }
    }

    function _pubkey(uint64 deviceId) internal pure returns (bytes memory) {
        return abi.encodePacked(
            bytes32(uint256(deviceId)),
            bytes32(uint256(deviceId) | (uint256(1) << 64))
        );
    }
}

// ============================================================================
// V3InvariantsTest — main test contract
// ============================================================================

contract V3InvariantsTest is StdInvariant, Test {
    EnergyProofRegistryV3 public v3;
    MockDeviceRegistryInv public dr;
    MockP256VerifierInvTrue public p256;
    MockHonkVerifierInvTrue public honk;
    V3InvariantHandler public handler;

    /// MAX_GAP_SECONDS in V3 is `48 hours` — kept in sync here
    uint64 internal constant MAX_GAP_SECONDS = 48 hours;

    function setUp() public {
        dr = new MockDeviceRegistryInv();
        p256 = new MockP256VerifierInvTrue();
        honk = new MockHonkVerifierInvTrue();

        // Deploy V3 logic + UUPS proxy, this test as admin
        EnergyProofRegistryV3 impl = new EnergyProofRegistryV3();
        bytes memory initData = abi.encodeWithSelector(
            EnergyProofRegistryV3.initialize.selector,
            address(this),
            address(dr),
            address(p256),
            address(honk)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        v3 = EnergyProofRegistryV3(payable(address(proxy)));

        // Register 5 distinct test devices
        for (uint64 i = 1; i <= 5; i++) {
            bytes memory pk = abi.encodePacked(
                bytes32(uint256(i)),
                bytes32(uint256(i) | (uint256(1) << 64))
            );
            dr.setAuthorized(pk, true);
        }

        // Spawn handler and grant it OPERATOR_ROLE so its submitProof calls
        // can reach the success path
        handler = new V3InvariantHandler(v3);
        v3.grantRole(v3.OPERATOR_ROLE(), address(handler));

        // Restrict invariant fuzz target to handler.submit() — without this
        // Forge would also fuzz inherited Test methods, which is undesirable.
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = V3InvariantHandler.submit.selector;
        targetSelector(
            FuzzSelector({addr: address(handler), selectors: selectors})
        );
    }

    // -----------------------------------------------------------------------
    // Invariant #4 — postDisconnection must match (gap > MAX_GAP_SECONDS)
    //
    // V3 sets postDisconnection := (gap > MAX_GAP_SECONDS). For every
    // ProofSubmitted event captured during fuzzing, this relationship must
    // hold. A failure would mean V3 misreports the disconnection flag —
    // a real security property because downstream systems may treat
    // post-disconnection submissions differently for SLA / billing.
    // -----------------------------------------------------------------------

    function invariant_postDisconnectionMatchesGap() public view {
        uint256 count = handler.getCaptureCount();
        for (uint256 i = 0; i < count; i++) {
            V3InvariantHandler.Capture memory c = handler.getCapture(i);
            bool shouldBePostDisconn = c.gapFromPrevious > MAX_GAP_SECONDS;
            assertEq(
                c.postDisconnection,
                shouldBePostDisconn,
                "Invariant #4: postDisconnection mismatch with gap > MAX_GAP_SECONDS"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Invariant #7 — payload-hash consistency
    //
    // V3 has an explicit CHECK 4 in submitProof:
    //     if (pubInputs.payloadHash != payloadHash) revert PayloadHashMismatch(...)
    // Therefore every successful submit must have pi.payloadHash == param.
    // The handler deliberately fuzzes both values independently; this
    // invariant asserts that whenever the call succeeds (event captured),
    // the two values were equal at call time.
    // -----------------------------------------------------------------------

    function invariant_payloadHashConsistency() public view {
        uint256 count = handler.getCaptureCount();
        for (uint256 i = 0; i < count; i++) {
            V3InvariantHandler.Capture memory c = handler.getCapture(i);
            assertEq(
                c.piPayloadHash,
                c.paramPayloadHash,
                "Invariant #7: emitted ProofSubmitted requires pi.payloadHash == param.payloadHash"
            );
        }
    }
}
