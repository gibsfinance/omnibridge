// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/**
 * @title MockReentrantRecoverer
 * @dev A payout recipient that, when it receives tokens through a transfer hook,
 * calls the router's recover() for another stranded message. It records the
 * outcome of that call. Used to test that a payout cannot re-enter recovery.
 */
contract MockReentrantRecoverer {
    /// @notice The router to call back.
    address public router;
    /// @notice The message to replay from inside the payout.
    bytes public replayMessage;
    /// @notice The signatures for that message.
    bytes public replaySignatures;
    /// @notice True until the hook has made its one re-entrant call.
    bool public armed;
    /// @notice True when a re-entrant call was made.
    bool public reentrantCallMade;
    /// @notice True when the re-entrant recover() returned without reverting.
    bool public reentrantCallSucceeded;
    /// @notice The revert data of the re-entrant recover(), empty when it succeeded.
    bytes public reentrantCallRevertData;

    /// @dev Sets the router and the message to replay, and arms the hook for one call.
    function arm(address routerAddress, bytes calldata message, bytes calldata signatures) external {
        router = routerAddress;
        replayMessage = message;
        replaySignatures = signatures;
        armed = true;
    }

    /// @dev Called by the token after a transfer to this contract. Re-enters recover() once.
    function onTokenTransferReceived(address, uint256) external {
        if (!armed) {
            return;
        }
        armed = false;
        reentrantCallMade = true;
        (bool success, bytes memory returned) =
            router.call(abi.encodeWithSignature("recover(bytes,bytes)", replayMessage, replaySignatures));
        reentrantCallSucceeded = success;
        if (!success) {
            reentrantCallRevertData = returned;
        }
    }
}
