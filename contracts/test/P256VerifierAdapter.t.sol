// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {P256VerifierAdapter} from "../src/P256VerifierAdapter.sol";

// =============================================================================
// Mock verifiers — різні поведінки для тестування adapter logic
// =============================================================================

/// Mock що повертає uint256(1) — valid signature.
/// Daimo P256 verifier returns 32 bytes containing uint256(1) on success.
contract MockVerifierReturnTrue {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 32)
        }
    }
}

/// Mock що повертає uint256(0) — invalid signature canonical response.
contract MockVerifierReturnFalse {
    fallback() external {
        assembly {
            mstore(0, 0)
            return(0, 32)
        }
    }
}

/// Mock що повертає uint256(2) — non-canonical "truthy" value.
/// Adapter мусить strict-equal до 1, тому 2 → false.
contract MockVerifierReturnTwo {
    fallback() external {
        assembly {
            mstore(0, 2)
            return(0, 32)
        }
    }
}

/// Mock з wrong return length (16 bytes замість 32).
/// Adapter мусить check result.length == 32.
contract MockVerifierWrongLength {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 16)
        }
    }
}

/// Mock що повертає 64 bytes (overlong return).
contract MockVerifierTooLong {
    fallback() external {
        assembly {
            mstore(0, 1)
            mstore(32, 0)
            return(0, 64)
        }
    }
}

/// Mock що reverts на будь-який call.
contract MockVerifierReverts {
    fallback() external {
        revert("verifier disabled");
    }
}

/// Mock що повертає empty bytes (length 0).
/// Solidity's empty fallback returns no data — ні assembly statement не потрібен.
contract MockVerifierEmptyReturn {
    // Inentionally empty — fallback returns no data
    fallback() external {}
}

// =============================================================================
// Tests
// =============================================================================

contract P256VerifierAdapterTest is Test {
    // Sample test data — distinct non-zero values щоб помітити encoding mistakes
    bytes32 constant HASH = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
    bytes32 constant SIG_R = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
    bytes32 constant SIG_S = bytes32(uint256(0x3333333333333333333333333333333333333333333333333333333333333333));
    bytes32 constant PUB_X = bytes32(uint256(0x4444444444444444444444444444444444444444444444444444444444444444));
    bytes32 constant PUB_Y = bytes32(uint256(0x5555555555555555555555555555555555555555555555555555555555555555));

    // =========================================================================
    // Constructor
    // =========================================================================

    function test_Constructor_StoresVerifierAddress() public {
        address verifierAddr = address(new MockVerifierReturnTrue());
        P256VerifierAdapter adapter = new P256VerifierAdapter(verifierAddr);
        assertEq(adapter.verifier(), verifierAddr);
    }

    function test_Revert_Constructor_ZeroAddress() public {
        vm.expectRevert(bytes("ZeroAddress"));
        new P256VerifierAdapter(address(0));
    }

    function test_Constructor_NonContractAddress_Allowed() public {
        // Constructor checks тільки for zero — EOA / non-contract addresses дозволені.
        // Поведінка з non-contract verifier перевіряється у verify() tests.
        // makeAddr — Forge idiom, deterministic + checksummed automatically.
        address eoa = makeAddr("non-contract-verifier");
        P256VerifierAdapter adapter = new P256VerifierAdapter(eoa);
        assertEq(adapter.verifier(), eoa);
    }

    // =========================================================================
    // verify() — happy path
    // =========================================================================

    function test_Verify_ValidSignatureReturnsTrue() public {
        P256VerifierAdapter adapter = new P256VerifierAdapter(
            address(new MockVerifierReturnTrue())
        );
        bool result = adapter.verify(HASH, SIG_R, SIG_S, PUB_X, PUB_Y);
        assertTrue(result);
    }

    // =========================================================================
    // verify() — branches: ok / result.length / value
    // =========================================================================

    function test_Verify_VerifierReturnsZero_False() public {
        // Branch: ok=true, length=32, value=0 (not 1) → false
        P256VerifierAdapter adapter = new P256VerifierAdapter(
            address(new MockVerifierReturnFalse())
        );
        bool result = adapter.verify(HASH, SIG_R, SIG_S, PUB_X, PUB_Y);
        assertFalse(result);
    }

    function test_Verify_VerifierReturnsNonOne_False() public {
        // Branch: ok=true, length=32, value=2 (non-canonical truthy) → false
        // Strict equality check критично — захист від verifier що returns non-1 truthy.
        P256VerifierAdapter adapter = new P256VerifierAdapter(
            address(new MockVerifierReturnTwo())
        );
        bool result = adapter.verify(HASH, SIG_R, SIG_S, PUB_X, PUB_Y);
        assertFalse(result);
    }

    function test_Verify_WrongReturnLength_16Bytes_False() public {
        // Branch: ok=true, length != 32 → false (regardless of value)
        P256VerifierAdapter adapter = new P256VerifierAdapter(
            address(new MockVerifierWrongLength())
        );
        bool result = adapter.verify(HASH, SIG_R, SIG_S, PUB_X, PUB_Y);
        assertFalse(result);
    }

    function test_Verify_OverlongReturn_64Bytes_False() public {
        // Branch: ok=true, length > 32 → false
        // Захист від verifier що повертає extra trailing data.
        P256VerifierAdapter adapter = new P256VerifierAdapter(
            address(new MockVerifierTooLong())
        );
        bool result = adapter.verify(HASH, SIG_R, SIG_S, PUB_X, PUB_Y);
        assertFalse(result);
    }

    function test_Verify_VerifierReverts_False() public {
        // Branch: ok=false (staticcall failed) → false
        P256VerifierAdapter adapter = new P256VerifierAdapter(
            address(new MockVerifierReverts())
        );
        bool result = adapter.verify(HASH, SIG_R, SIG_S, PUB_X, PUB_Y);
        assertFalse(result);
    }

    function test_Verify_EmptyReturn_False() public {
        // Branch: ok=true, length=0 → false
        // Empty fallback returns no data.
        P256VerifierAdapter adapter = new P256VerifierAdapter(
            address(new MockVerifierEmptyReturn())
        );
        bool result = adapter.verify(HASH, SIG_R, SIG_S, PUB_X, PUB_Y);
        assertFalse(result);
    }

    function test_Verify_NonContractAddress_False() public {
        // EOA address без code → staticcall succeeds (returns empty) but result.length == 0.
        // Це означає "fail safe" — non-contract verifier повертає false замість revert.
        address eoa = makeAddr("eoa-no-code");
        P256VerifierAdapter adapter = new P256VerifierAdapter(eoa);
        bool result = adapter.verify(HASH, SIG_R, SIG_S, PUB_X, PUB_Y);
        assertFalse(result);
    }

    // =========================================================================
    // verify() — encoding format verification
    // =========================================================================
    // Daimo's verifier очікує raw 160 bytes (hash || r || s || x || y) БЕЗ function
    // selector. Adapter мусить використовувати abi.encodePacked, не abi.encode.

    function test_Verify_CalldataEncoding_Exactly160Bytes() public {
        MockVerifierReturnTrue mock = new MockVerifierReturnTrue();
        P256VerifierAdapter adapter = new P256VerifierAdapter(address(mock));

        // Expected: 5 × 32 bytes = 160 bytes, БЕЗ selector
        bytes memory expectedCalldata = abi.encodePacked(
            HASH, SIG_R, SIG_S, PUB_X, PUB_Y
        );
        assertEq(expectedCalldata.length, 160, "test setup: expected calldata is 160 bytes");

        vm.expectCall(address(mock), expectedCalldata);
        adapter.verify(HASH, SIG_R, SIG_S, PUB_X, PUB_Y);
    }

    function test_Verify_CalldataEncoding_FieldOrder() public {
        // Перевіряє field order у packed encoding: hash → r → s → x → y.
        MockVerifierReturnTrue mock = new MockVerifierReturnTrue();
        P256VerifierAdapter adapter = new P256VerifierAdapter(address(mock));

        // Constructed explicit packed bytes у correct order
        bytes memory expected = bytes.concat(HASH, SIG_R, SIG_S, PUB_X, PUB_Y);

        vm.expectCall(address(mock), expected);
        adapter.verify(HASH, SIG_R, SIG_S, PUB_X, PUB_Y);
    }

    function test_Verify_ZeroInputs_StillForwarded() public {
        // No input validation у adapter — все 0 forwarded to verifier як 160 zero bytes.
        // Verifier сам вирішує що з ними робити.
        MockVerifierReturnFalse mock = new MockVerifierReturnFalse();
        P256VerifierAdapter adapter = new P256VerifierAdapter(address(mock));

        bytes memory expectedCalldata = abi.encodePacked(
            bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0)
        );

        vm.expectCall(address(mock), expectedCalldata);
        bool result = adapter.verify(bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0));
        assertFalse(result); // mock returns 0
    }

    function test_Verify_NoFunctionSelectorInCalldata() public {
        // Sanity check — adapter НЕ використовує abi.encodeWithSelector / abi.encode.
        // Якщо випадково використає — calldata буде >= 164 bytes (selector + ABI overhead).
        MockVerifierReturnTrue mock = new MockVerifierReturnTrue();
        P256VerifierAdapter adapter = new P256VerifierAdapter(address(mock));

        // Якщо бажається використати abi.encode — calldata буде 5×32 + selector + length prefix
        // ≈ 192 bytes (з ABI overhead). Adapter must use abi.encodePacked = exactly 160.
        bytes memory exactExpected = abi.encodePacked(HASH, SIG_R, SIG_S, PUB_X, PUB_Y);
        require(exactExpected.length == 160, "test setup error");

        vm.expectCall(address(mock), exactExpected);
        adapter.verify(HASH, SIG_R, SIG_S, PUB_X, PUB_Y);
    }
}
