// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/**
 * @title MockPayoutReceiver
 * @dev A contract that refuses native coin until told to accept it. Used to test failed payouts.
 */
contract MockPayoutReceiver {
    /// @notice True when native coin is accepted.
    bool public accepting;

    /**
     * @dev Sets whether native coin is accepted.
     */
    function setAccepting(bool value) external {
        accepting = value;
    }

    receive() external payable {
        require(accepting, "not accepting");
    }
}
