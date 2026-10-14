// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {IERC20Receiver} from "../interfaces/IERC20Receiver.sol";

/**
 * @title MockReentrantMediator
 * @dev An allowed mediator that calls `onTokenBridged` again when it is paid native coin.
 * Used to test that HomeFeeLedger skips, and does not revert, on a reentrant delivery.
 */
contract MockReentrantMediator {
    /// @notice The ledger to call back.
    address public target;
    /// @notice True when the reentrant call returned without reverting.
    bool public reentrantCallSucceeded;

    /**
     * @dev Sets the ledger to call back.
     */
    function setTarget(address value) external {
        target = value;
    }

    receive() external payable {
        (reentrantCallSucceeded,) =
            target.call(abi.encodeWithSelector(IERC20Receiver.onTokenBridged.selector, address(this), 1, ""));
    }
}
