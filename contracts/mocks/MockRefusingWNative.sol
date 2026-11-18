// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {WETH} from "./WETH.sol";

/**
 * @title MockRefusingWNative
 * @dev A wrapped native token that unwraps normally but can refuse to wrap. Used to test a payout
 * that fails twice: the send fails, then the coin cannot be wrapped back.
 */
contract MockRefusingWNative is WETH {
    /// @notice When true, `deposit` reverts, so native coin cannot be wrapped.
    bool public refusingDeposits;

    /**
     * @dev Sets whether `deposit` refuses.
     * @param value true to refuse wrapping.
     */
    function setRefusingDeposits(bool value) external {
        refusingDeposits = value;
    }

    /**
     * @dev Wraps native coin unless wrapping is refused.
     */
    function deposit() public payable override {
        require(!refusingDeposits, "deposits refused");
        super.deposit();
    }
}
