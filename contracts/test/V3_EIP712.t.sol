// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {V3TestBase} from "./V3TestBase.sol";
import {EnergyProofRegistryV3, PublicInputs} from "../src/EnergyProofRegistryV3.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title V3_EIP712Test
/// @notice Tests for EIP-712 typed signing layer (v0.3).
/// @dev Inherits V3TestBase — same mocks, same setUp. The mocks return true
///      regardless of signature input, so these tests focus on the DIGEST
///      COMPUTATION correctness (not signature verification correctness).
///      End-to-end signature flow is verified at the Sepolia integration
///      layer via edge/scripts/sepolia_smoke.py with a real P-256 signer.
contract V3_EIP712Test is V3TestBase {

    // -----------------------------------------------------------------------
    // Reference constants — must match V3.sol exactly
    // -----------------------------------------------------------------------

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 internal constant ENERGY_PROOF_TYPEHASH = keccak256(
        "EnergyProof(uint64 deviceId,uint64 sessionId,uint64 epochStartTs,int64 lat_e7,int64 lon_e7,uint64 lightLevel,uint64 tamperFlag,bytes32 payloadHash,uint64 totalEnergyMWh)"
    );

    bytes32 internal constant DOMAIN_NAME_HASH = keccak256(bytes("InfraVeritas Energy"));
    bytes32 internal constant DOMAIN_VERSION_HASH = keccak256(bytes("1"));

    // -----------------------------------------------------------------------
    // Reference computation helpers — for cross-checking on-chain output
    // -----------------------------------------------------------------------

    function _expectedDomainSeparator(uint256 chainId, address verifyingContract)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            DOMAIN_NAME_HASH,
            DOMAIN_VERSION_HASH,
            chainId,
            verifyingContract
        ));
    }

    function _expectedStructHash(PublicInputs memory pi) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            ENERGY_PROOF_TYPEHASH,
            pi.deviceId,
            pi.sessionId,
            pi.epochStartTs,
            pi.lat_e7,
            pi.lon_e7,
            pi.lightLevel,
            pi.tamperFlag,
            pi.payloadHash,
            pi.totalEnergyMWh
        ));
    }

    function _expectedDigest(PublicInputs memory pi, bytes32 separator)
        internal
        pure
        returns (bytes32)
    {
        bytes32 structHash = _expectedStructHash(pi);
        return keccak256(abi.encodePacked(hex"1901", separator, structHash));
    }

    // =======================================================================
    // Domain separator tests
    // =======================================================================

    /// @notice domainSeparator() must return the cached value after initialize().
    function testDomainSeparator_returnsCachedAfterInitialize() public view {
        bytes32 expected = _expectedDomainSeparator(block.chainid, address(v3));
        assertEq(v3.domainSeparator(), expected, "Domain separator mismatch");
    }

    /// @notice After chainId changes (simulated fork), domainSeparator() lazy-rebuilds.
    /// @dev Without reinitializeEIP712, the cache stays stale but the read-only
    ///      function returns a freshly computed value bound to the new chain.
    function testDomainSeparator_rebuildsOnChainFork() public {
        bytes32 originalSeparator = v3.domainSeparator();

        // Simulate chain fork
        vm.chainId(424242);

        bytes32 newSeparator = v3.domainSeparator();

        assertTrue(
            originalSeparator != newSeparator,
            "Separator must change on chain fork"
        );

        bytes32 expectedFresh = _expectedDomainSeparator(424242, address(v3));
        assertEq(newSeparator, expectedFresh, "Rebuilt separator must match expected");
    }

    /// @notice Different contract addresses produce different domain separators.
    function testDomainSeparator_differsByContractAddress() public {
        // Deploy a second V3 instance at a different address.
        EnergyProofRegistryV3 impl2 = new EnergyProofRegistryV3();
        bytes memory initData2 = abi.encodeCall(
            EnergyProofRegistryV3.initialize,
            (admin, address(mockRegistry), address(mockP256), address(mockHonk))
        );
        ERC1967Proxy proxy2 = new ERC1967Proxy(address(impl2), initData2);
        EnergyProofRegistryV3 v3_two = EnergyProofRegistryV3(address(proxy2));

        assertTrue(
            v3.domainSeparator() != v3_two.domainSeparator(),
            "Different addresses must produce different separators"
        );
    }

    // =======================================================================
    // EIP-712 digest tests
    // =======================================================================

    /// @notice eip712Digest() output matches the reference EIP-712 computation.
    function testEIP712Digest_matchesReferenceComputation() public view {
        PublicInputs memory pi = _buildValidPubInputs();
        bytes32 expected = _expectedDigest(pi, v3.domainSeparator());
        assertEq(v3.eip712Digest(pi), expected, "Digest mismatch reference");
    }

    /// @notice Different PublicInputs values produce different digests.
    function testEIP712Digest_changesWithDifferentInputs() public view {
        PublicInputs memory pi1 = _buildValidPubInputs();
        PublicInputs memory pi2 = _buildValidPubInputs();
        pi2.sessionId = 99999;

        assertTrue(
            v3.eip712Digest(pi1) != v3.eip712Digest(pi2),
            "Different inputs must produce different digests"
        );
    }

    /// @notice Digest is bound to chainId — same struct on different chains differs.
    function testEIP712Digest_changesWithChainId() public {
        PublicInputs memory pi = _buildValidPubInputs();
        bytes32 digestCurrentChain = v3.eip712Digest(pi);

        vm.chainId(424242);
        bytes32 digestForkedChain = v3.eip712Digest(pi);

        assertTrue(
            digestCurrentChain != digestForkedChain,
            "Different chainId must change digest"
        );
    }

    /// @notice Digest is bound to verifyingContract — same struct on different V3 instances differs.
    function testEIP712Digest_changesWithContractAddress() public {
        EnergyProofRegistryV3 impl2 = new EnergyProofRegistryV3();
        bytes memory initData2 = abi.encodeCall(
            EnergyProofRegistryV3.initialize,
            (admin, address(mockRegistry), address(mockP256), address(mockHonk))
        );
        ERC1967Proxy proxy2 = new ERC1967Proxy(address(impl2), initData2);
        EnergyProofRegistryV3 v3_two = EnergyProofRegistryV3(address(proxy2));

        PublicInputs memory pi = _buildValidPubInputs();

        assertTrue(
            v3.eip712Digest(pi) != v3_two.eip712Digest(pi),
            "Different verifyingContract must change digest"
        );
    }

    // =======================================================================
    // Reinitializer tests
    // =======================================================================

    /// @notice reinitializeEIP712 can be called once and only once after upgrade.
    /// @dev initialize() set OZ initialized version to 1. reinitializer(2) modifier
    ///      bumps it to 2 — second call must revert with InvalidInitialization.
    function testReinitializeEIP712_canBeCalledOnce() public {
        // First call as admin should succeed
        vm.prank(admin);
        v3.reinitializeEIP712();

        // Domain separator should be cached now (same chain, no change expected)
        bytes32 expected = _expectedDomainSeparator(block.chainid, address(v3));
        assertEq(v3.domainSeparator(), expected, "Cache after reinit mismatch");
    }

    function testReinitializeEIP712_cannotBeCalledTwice() public {
        vm.prank(admin);
        v3.reinitializeEIP712();

        // Second call must revert (OZ InvalidInitialization)
        vm.prank(admin);
        vm.expectRevert();
        v3.reinitializeEIP712();
    }

    function testReinitializeEIP712_onlyAdmin() public {
        address notAdmin = makeAddr("notAdmin");
        vm.prank(notAdmin);
        vm.expectRevert(); // AccessControl: missing role
        v3.reinitializeEIP712();
    }

    // =======================================================================
    // Event emission tests
    // =======================================================================

    /// @notice DomainSeparatorCached event is emitted on reinitializeEIP712.
    function testReinitializeEIP712_emitsDomainSeparatorCached() public {
        bytes32 expectedSeparator = _expectedDomainSeparator(block.chainid, address(v3));

        vm.expectEmit(true, false, false, true, address(v3));
        emit EnergyProofRegistryV3.DomainSeparatorCached(block.chainid, expectedSeparator);

        vm.prank(admin);
        v3.reinitializeEIP712();
    }

    // =======================================================================
    // submitProof regression — happy path should still work with mocks
    // =======================================================================

    /// @notice With mocks returning true, submitProof still accepts after EIP-712 change.
    /// @dev This confirms the new digest computation does not break the existing flow.
    ///      Real signature validation is exercised in sepolia_smoke.py.
    function testSubmitProof_happyPathStillWorksWithEIP712Layer() public {
        _setMocksHappyPath();
        _submitWithDefaults();

        // If we reach here without revert, the EIP-712 layer integrated successfully.
        // Verify state was written:
        bytes32 sessionKey = _sessionKey(1, 100);
        assertTrue(v3.usedSessionKeys(sessionKey), "Session key must be marked used");
        assertEq(
            v3.lastSubmissionTimestamp(_deviceIdBytes32(1)),
            uint64(block.timestamp),
            "Last timestamp must be updated"
        );
    }
}
