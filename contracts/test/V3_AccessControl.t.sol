// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import { V3TestBase } from "./V3TestBase.sol";
import { EnergyProofRegistryV3, PublicInputs } from "../src/EnergyProofRegistryV3.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @title V3_AccessControl
/// @notice L-001 Access Control tests per docs/specs/V3_design.md §16.
/// @dev Verifies role-gated functions: submitProof (OPERATOR_ROLE),
///      setDeviceRegistry/setP256Verifier/setHonkVerifier/unpause (DEFAULT_ADMIN_ROLE),
///      pause (PAUSER_ROLE), _authorizeUpgrade (UPGRADER_ROLE).
contract V3_AccessControl_Test is V3TestBase {
    // -----------------------------------------------------------------------
    // submitProof — OPERATOR_ROLE gating
    // -----------------------------------------------------------------------

    /// @notice Non-operator calling submitProof reverts with AccessControlUnauthorizedAccount.
    function test_Revert_NonOperatorCannotSubmit() public {
        // Arrange
        address notOperator = makeAddr("notOperator");
        _setMocksHappyPath();
        PublicInputs memory pi = _buildValidPubInputs();

        // Act + Assert
        vm.prank(notOperator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, notOperator, operatorRole
            )
        );
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
    }

    /// @notice Operator (granted in setUp) can submit a valid proof.
    function test_OperatorCanSubmit() public {
        // Arrange
        _setMocksHappyPath();

        // Act
        _submitWithDefaults();

        // Assert — state was written
        bytes32 deviceIdB32 = _deviceIdBytes32(1);
        assertEq(
            v3.lastSubmissionTimestamp(deviceIdB32),
            uint64(block.timestamp),
            "lastSubmissionTimestamp not updated"
        );
        assertTrue(v3.usedSessionKeys(_sessionKey(1, 100)), "sessionKey not marked used");
    }

    /// @notice Admin can grant OPERATOR_ROLE to a new address, who can then submit.
    function test_AdminCanGrantOperatorRole() public {
        // Arrange
        address newOperator = makeAddr("newOperator");
        _setMocksHappyPath();

        vm.prank(admin);
        v3.grantRole(operatorRole, newOperator);

        // Act
        PublicInputs memory pi = _buildValidPubInputs();
        vm.prank(newOperator);
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);

        // Assert
        assertTrue(v3.hasRole(operatorRole, newOperator), "role not granted");
    }

    /// @notice After admin revokes OPERATOR_ROLE, submit reverts.
    function test_AdminCanRevokeOperatorRole() public {
        // Arrange
        _setMocksHappyPath();

        vm.prank(admin);
        v3.revokeRole(operatorRole, operator);

        // Act + Assert
        PublicInputs memory pi = _buildValidPubInputs();
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, operator, operatorRole
            )
        );
        v3.submitProof(pi, testPayloadHash, testSignature, testPubkey, testProof);
    }

    // -----------------------------------------------------------------------
    // unpause — DEFAULT_ADMIN_ROLE gating (asymmetric: pauser CANNOT unpause)
    // -----------------------------------------------------------------------

    /// @notice Pauser (has PAUSER_ROLE but not DEFAULT_ADMIN_ROLE) cannot unpause.
    /// @dev Asymmetric pattern per V3_design.md §11: pause = PAUSER_ROLE, unpause = DEFAULT_ADMIN_ROLE.
    function test_Revert_PauserCannotUnpause() public {
        // Arrange — first pause as pauser
        vm.prank(pauser);
        v3.pause();
        assertTrue(v3.paused(), "should be paused");

        // Act + Assert — pauser tries to unpause
        vm.prank(pauser);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, pauser, defaultAdminRole
            )
        );
        v3.unpause();
    }

    // -----------------------------------------------------------------------
    // Admin setters — DEFAULT_ADMIN_ROLE gating
    // -----------------------------------------------------------------------

    /// @notice Non-admin cannot call setDeviceRegistry.
    function test_Revert_NonAdminCannotChangeDeviceRegistry() public {
        // Arrange
        address notAdmin = makeAddr("notAdmin");
        address newRegistry = makeAddr("newRegistry");

        // Act + Assert
        vm.prank(notAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, notAdmin, defaultAdminRole
            )
        );
        v3.setDeviceRegistry(newRegistry);
    }

    // -----------------------------------------------------------------------
    // UUPS upgrade — UPGRADER_ROLE gating
    // -----------------------------------------------------------------------

    /// @notice Non-upgrader cannot call upgradeToAndCall (which triggers _authorizeUpgrade).
    /// @dev UPGRADER_ROLE is granted to admin in initialize(); other addresses revert.
    function test_Revert_NonUpgraderCannotUpgrade() public {
        // Arrange
        address notUpgrader = makeAddr("notUpgrader");
        EnergyProofRegistryV3 newImpl = new EnergyProofRegistryV3();

        // Act + Assert
        vm.prank(notUpgrader);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, notUpgrader, upgraderRole
            )
        );
        v3.upgradeToAndCall(address(newImpl), "");
    }
}
