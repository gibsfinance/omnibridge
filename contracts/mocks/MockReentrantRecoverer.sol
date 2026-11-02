// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/**
 * @title MockReentrantRecoverer
 * @dev A payout recipient that, when it receives tokens through a transfer hook,
 * calls back into the router once: recover() for another stranded message (see
 * {arm}), or the single delivery entry (see {armEntry}). It records the outcome
 * of that call. Used to test that a payout cannot re-enter the router.
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
    /// @notice The revert data of the re-entrant call, empty when it succeeded.
    bytes public reentrantCallRevertData;
    /// @notice True when the hook calls the single delivery entry instead of recover().
    bool public reentersEntry;
    /// @notice The courier the re-entrant entry call names.
    address public entryCourier;

    /// @dev Sets the router and the message to replay, and arms the hook for one recover() call.
    function arm(address routerAddress, bytes calldata message, bytes calldata signatures) external {
        router = routerAddress;
        replayMessage = message;
        replaySignatures = signatures;
        reentersEntry = false;
        armed = true;
    }

    /**
     * @dev Arms the hook for one call to the router's single delivery entry,
     * safeExecuteSignaturesWithAutoGasLimit(courier, message, signatures).
     * @param routerAddress the router to call back
     * @param courier the courier the re-entrant call names
     * @param message the message the re-entrant call sends
     * @param signatures the signatures for that message
     */
    function armEntry(address routerAddress, address courier, bytes calldata message, bytes calldata signatures) external {
        router = routerAddress;
        replayMessage = message;
        replaySignatures = signatures;
        entryCourier = courier;
        reentersEntry = true;
        armed = true;
    }

    /// @dev Called by the token after a transfer to this contract. Re-enters the router once.
    function onTokenTransferReceived(address, uint256) external {
        if (!armed) {
            return;
        }
        armed = false;
        reentrantCallMade = true;
        bytes memory reentrantCall = reentersEntry
            ? abi.encodeWithSignature(
                "safeExecuteSignaturesWithAutoGasLimit(address,bytes,bytes)", entryCourier, replayMessage, replaySignatures
            )
            : abi.encodeWithSignature("recover(bytes,bytes)", replayMessage, replaySignatures);
        (bool success, bytes memory returned) = router.call(reentrantCall);
        reentrantCallSucceeded = success;
        if (!success) {
            reentrantCallRevertData = returned;
        }
    }
}
