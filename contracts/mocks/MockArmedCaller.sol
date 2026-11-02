// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/**
 * @title ArmedCall
 * @dev Holds one call (a target and its calldata) that fires once, and records
 * how it went. Shared by the test mocks that call into a router from code an
 * attacker controls.
 */
abstract contract ArmedCall {
    /// @notice The contract the armed call goes to.
    address public target;
    /// @notice The calldata of the armed call.
    bytes public callData;
    /// @notice True until the armed call has fired.
    bool public armed;
    /// @notice True once the armed call has fired.
    bool public callMade;
    /// @notice True when the armed call returned without reverting.
    bool public callSucceeded;
    /// @notice The revert data of the armed call, empty when it succeeded.
    bytes public callRevertData;

    /**
     * @dev Arms one call to `targetAddress` with `data`.
     * @param targetAddress the contract to call
     * @param data the calldata to send
     */
    function arm(address targetAddress, bytes calldata data) external {
        target = targetAddress;
        callData = data;
        armed = true;
    }

    /// @dev Makes the armed call once, if armed, and records the result. Never reverts.
    function _fireArmedCall() internal {
        if (!armed) {
            return;
        }
        armed = false;
        callMade = true;
        (bool success, bytes memory returned) = target.call(callData);
        callSucceeded = success;
        if (!success) {
            callRevertData = returned;
        }
    }
}

/**
 * @title MockArmedCaller
 * @dev A contract that makes its armed call when {fire} runs, for example as the
 * target of a relayed message.
 */
contract MockArmedCaller is ArmedCall {
    /// @dev Makes the armed call. Never reverts.
    function fire() external {
        _fireArmedCall();
    }
}
