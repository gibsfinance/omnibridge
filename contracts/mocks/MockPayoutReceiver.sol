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

    /**
     * @dev Calls `withdraw(address(0))` on a HomeFeeLedger, so this contract receives its native coin credit.
     * @param ledger the ledger holding the credit.
     */
    function claimNative(address ledger) external {
        (bool success,) = ledger.call(abi.encodeWithSignature("withdraw(address)", address(0)));
        require(success, "claim failed");
    }

    receive() external payable {
        require(accepting, "not accepting");
    }
}
